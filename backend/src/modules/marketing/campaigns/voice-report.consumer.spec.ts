import { VoiceReportConsumer } from './voice-report.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingVoiceReportPayload } from '../events/marketing-event-types';

function makeEvent(id: string, overrides: Partial<MarketingVoiceReportPayload> = {}): DomainEvent<MarketingVoiceReportPayload> {
  const payload: MarketingVoiceReportPayload = {
    workspaceId: 'ws-1',
    relationid: 'recip-1',
    state: '1',
    bilsec: null,
    pushButton: null,
    recordLink: null,
    ...overrides,
  };
  return {
    id,
    type: MarketingEventTypes.VoiceReport,
    tenantId: null,
    idempotencyKey: id,
    createdAt: new Date('2026-07-09T10:00:00.000Z'),
    payload,
  };
}

const RECIPIENT = {
  id: 'recip-1',
  workspaceId: 'ws-1',
  campaignId: 'camp-1',
  leadId: 'lead-1',
  voiceState: null as string | null,
};

/**
 * VoiceReportConsumer correlates purely by relationid == CampaignRecipient.id
 * (workspace-scoped), writes voiceState/pushButton/talkSec with a guard that
 * never regresses a terminal ANSWERED outcome, rolls campaign.stats voice
 * counters, and fires the press-1 -> workflow keypress event. The behaviors
 * that matter most:
 *  - unknown relationid is skipped, never guessed at;
 *  - ANSWERED, once recorded, is never regressed by a later report;
 *  - bilsec>0 wins over the durum code (defensive mapping);
 *  - pushButton matching voiceConfig.keys emits the keypress event, idempotent
 *    per (recipientId, key);
 *  - never touches netgsmJobId/referansId.
 */
describe('VoiceReportConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock; off: jest.Mock };
  let outbox: { append: jest.Mock };
  let svc: VoiceReportConsumer;

  const handle = (e: DomainEvent<MarketingVoiceReportPayload>) => (svc as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    outbox = { append: jest.fn().mockResolvedValue('evt-out-1') };
    svc = new VoiceReportConsumer(prisma as any, bus as any, outbox as any);

    (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT });
    (prisma.campaignRecipient.update as jest.Mock).mockResolvedValue({});
    (prisma.campaignRecipient.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.campaignRecipient.count as jest.Mock).mockResolvedValue(0);
    (prisma.campaign.findFirst as jest.Mock).mockResolvedValue({ stats: {}, voiceConfig: { keys: ['1', '2'] } });
    (prisma.campaign.update as jest.Mock).mockResolvedValue({});
  });

  it('subscribes to marketing.voice.report.v1 on module init, and detaches on destroy', () => {
    svc.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.VoiceReport, expect.any(Function));
    svc.onModuleDestroy();
    expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.VoiceReport, expect.any(Function));
  });

  describe('correlation', () => {
    it('correlates by relationid == CampaignRecipient.id, workspace-scoped', async () => {
      await handle(makeEvent('evt-1', { relationid: 'recip-1', workspaceId: 'ws-1' }));

      expect(prisma.campaignRecipient.findFirst).toHaveBeenCalledWith({
        where: { id: 'recip-1', workspaceId: 'ws-1' },
        select: { id: true, workspaceId: true, campaignId: true, leadId: true, voiceState: true },
      });
    });

    it('unknown relationid is skipped — never guessed at via a fallback lookup', async () => {
      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue(null);

      await handle(makeEvent('evt-1', { relationid: 'no-such-recipient' }));

      expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('a missing workspaceId/relationid on the payload is skipped without a DB read', async () => {
      await handle(makeEvent('evt-1', { workspaceId: '' }));
      expect(prisma.campaignRecipient.findFirst).not.toHaveBeenCalled();

      await handle(makeEvent('evt-2', { relationid: '' }));
      expect(prisma.campaignRecipient.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('voiceState mapping + monotonic guard', () => {
    it('durum=1 (no bilsec) maps to ANSWERED', async () => {
      await handle(makeEvent('evt-1', { state: '1', bilsec: null }));
      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'recip-1' },
        data: { voiceState: 'ANSWERED' },
      });
    });

    it('durum=2 maps to BUSY, durum=3 to NO_ANSWER, durum=7 to FAILED, unrecognized to UNKNOWN', async () => {
      await handle(makeEvent('evt-busy', { relationid: 'recip-1', state: '2' }));
      expect(prisma.campaignRecipient.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ voiceState: 'BUSY' }) }),
      );

      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'BUSY' });
      await handle(makeEvent('evt-noanswer', { relationid: 'recip-1', state: '3' }));
      expect(prisma.campaignRecipient.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ voiceState: 'NO_ANSWER' }) }),
      );

      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'NO_ANSWER' });
      await handle(makeEvent('evt-failed', { relationid: 'recip-1', state: '7' }));
      expect(prisma.campaignRecipient.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ voiceState: 'FAILED' }) }),
      );

      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'FAILED' });
      await handle(makeEvent('evt-unknown', { relationid: 'recip-1', state: '99' }));
      expect(prisma.campaignRecipient.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ voiceState: 'UNKNOWN' }) }),
      );
    });

    it('a positive bilsec (talk seconds) wins over the durum code — ANSWERED regardless of the reported state', async () => {
      await handle(makeEvent('evt-1', { state: '3', bilsec: 12 }));
      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'recip-1' },
        data: { voiceState: 'ANSWERED', talkSec: 12 },
      });
    });

    it('never regresses a terminal ANSWERED voiceState — a later NO_ANSWER/BUSY/FAILED report is dropped for that field', async () => {
      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'ANSWERED' });

      await handle(makeEvent('evt-1', { state: '3', bilsec: null }));

      // voiceState is never in the patch — no update call at all here, since
      // there's also no pushButton/bilsec in this event to persist.
      expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
    });

    it('a non-ANSWERED state CAN be upgraded to ANSWERED by a later report', async () => {
      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'BUSY' });

      await handle(makeEvent('evt-1', { state: '1', bilsec: 30 }));

      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'recip-1' },
        data: { voiceState: 'ANSWERED', talkSec: 30 },
      });
    });

    it('a redelivered report carrying the SAME already-stored state is a no-op write (nothing changes)', async () => {
      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'BUSY' });

      await handle(makeEvent('evt-1', { state: '2', bilsec: null }));

      expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
    });

    it('ANSWERED, once recorded, still accepts a LATER pushButton/talkSec update (only voiceState itself is guarded)', async () => {
      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'ANSWERED' });

      await handle(makeEvent('evt-1', { state: '1', pushButton: '1' }));

      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'recip-1' },
        data: { pushButton: '1' },
      });
    });
  });

  describe('campaign.stats rollup', () => {
    it('rolls voice counters into campaign.stats (spread-preserve merge) after a voiceState write', async () => {
      (prisma.campaignRecipient.groupBy as jest.Mock).mockResolvedValue([
        { voiceState: 'ANSWERED', _count: { _all: 3 } },
        { voiceState: 'BUSY', _count: { _all: 1 } },
      ]);
      (prisma.campaignRecipient.count as jest.Mock).mockResolvedValue(2);
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue({ stats: { sent: 10, delivered: 9 }, voiceConfig: {} });

      await handle(makeEvent('evt-1', { state: '1', bilsec: 5 }));

      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: {
          stats: {
            sent: 10,
            delivered: 9,
            voiceAnswered: 3,
            voiceBusy: 1,
            voiceNoAnswer: 0,
            voiceFailed: 0,
            voiceUnknown: 0,
            voicePressed: 2,
          },
        },
      });
    });

    it('does NOT roll stats when the report changes nothing (voiceState guarded off, no pushButton/bilsec)', async () => {
      (prisma.campaignRecipient.findFirst as jest.Mock).mockResolvedValue({ ...RECIPIENT, voiceState: 'ANSWERED' });

      await handle(makeEvent('evt-1', { state: '3' }));

      expect(prisma.campaign.update).not.toHaveBeenCalled();
    });
  });

  describe('press-1 -> workflow keypress trigger', () => {
    it('emits marketing.voice.keypress.v1 when pushButton matches a configured voiceConfig.keys digit', async () => {
      await handle(makeEvent('evt-1', { pushButton: '1' }));

      expect(prisma.campaign.findFirst).toHaveBeenCalledWith({
        where: { id: 'camp-1', workspaceId: 'ws-1' },
        select: { voiceConfig: true },
      });
      expect(outbox.append).toHaveBeenCalledWith({
        type: MarketingEventTypes.VoiceKeypress,
        tenantId: null,
        payload: { workspaceId: 'ws-1', leadId: 'lead-1', campaignId: 'camp-1', recipientId: 'recip-1', key: '1' },
        idempotencyKey: 'voice-keypress:recip-1:1',
      });
    });

    it('does NOT emit a keypress event when pushButton is not one of the configured keys', async () => {
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue({ stats: {}, voiceConfig: { keys: ['1', '2'] } });

      await handle(makeEvent('evt-1', { pushButton: '9' }));

      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('does NOT emit a keypress event when there is no pushButton at all', async () => {
      await handle(makeEvent('evt-1', { pushButton: null }));
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('treats a missing/malformed voiceConfig.keys as no configured keys (never throws)', async () => {
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue({ stats: {}, voiceConfig: null });

      await expect(handle(makeEvent('evt-1', { pushButton: '1' }))).resolves.toBeUndefined();
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('idempotent redelivery', () => {
    it('the SAME event.id is only ever processed once (bounded in-memory dedupe)', async () => {
      const event = makeEvent('evt-dup-1', { pushButton: '1' });

      await handle(event);
      await handle(event);

      expect(prisma.campaignRecipient.findFirst).toHaveBeenCalledTimes(1);
      expect(outbox.append).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordLink', () => {
    it('logs a recordLink rather than dropping it silently or throwing (no column to persist it in yet)', async () => {
      const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

      await handle(makeEvent('evt-1', { recordLink: 'https://rec.example/1.wav' }));

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('https://rec.example/1.wav'));
    });
  });

  describe('never touches netgsmJobId/referansId', () => {
    it('the update payload never includes netgsmJobId or referansId', async () => {
      await handle(makeEvent('evt-1', { state: '1', bilsec: 20, pushButton: '2' }));

      const calls = (prisma.campaignRecipient.update as jest.Mock).mock.calls;
      for (const [args] of calls) {
        expect(args.data).not.toHaveProperty('netgsmJobId');
        expect(args.data).not.toHaveProperty('referansId');
      }
    });
  });
});
