import { TelephonyEventConsumer } from './telephony-event.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingCallEventPayload } from '../events/marketing-event-types';

function makeEvent(id: string, overrides: Partial<MarketingCallEventPayload> = {}): DomainEvent<MarketingCallEventPayload> {
  const payload: MarketingCallEventPayload = {
    workspaceId: 'ws-1',
    kind: 'hangup',
    uniqueId: null,
    crmId: null,
    customerNum: null,
    internalNum: null,
    direction: null,
    status: null,
    recording: null,
    durationSec: null,
    raw: {},
    ...overrides,
  };
  return {
    id,
    type: MarketingEventTypes.CallEvent,
    tenantId: null,
    idempotencyKey: id,
    createdAt: new Date('2026-07-09T10:00:00.000Z'),
    payload,
  };
}

/**
 * TelephonyEventConsumer writes INBOUND/missed SalesCall rows and correlates
 * OUTBOUND hangup/cdr events back to the SalesCall started via
 * SalesCallService.startCall. The behaviors that matter most:
 *  - crm_id correlation FIRST (our own SalesCall.id — the strongest signal);
 *  - the atomic monotonic claim so a terminal call is never re-finalized or
 *    regressed by a later/redelivered event;
 *  - INBOUND rows tolerate hangup/cdr arriving before inbound_call (upsert);
 *  - a missed call (INBOUND -> NO_ANSWER) fires exactly once.
 */
describe('TelephonyEventConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock; off: jest.Mock };
  let outbox: { append: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let svc: TelephonyEventConsumer;

  const handle = (e: DomainEvent<MarketingCallEventPayload>) => (svc as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    outbox = { append: jest.fn().mockResolvedValue('evt-out-1') };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    svc = new TelephonyEventConsumer(prisma as any, bus as any, outbox as any, autoAssigner as any);

    (prisma.salesCall.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  it('subscribes to marketing.telephony.call_event.v1 on module init, and detaches on destroy', () => {
    svc.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.CallEvent, expect.any(Function));
    svc.onModuleDestroy();
    expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.CallEvent, expect.any(Function));
  });

  describe('OUTBOUND hangup/cdr correlation', () => {
    it('correlates by crm_id FIRST, backfills externalCallId, and stamps CONNECTED', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-1',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'INITIATED',
        externalCallId: null,
        marketingUserId: 'rep-1',
        leadId: 'lead-1',
        answeredByUserId: null,
        toPhone: '05551112233',
      });

      await handle(
        makeEvent('evt-1', {
          kind: 'hangup',
          crmId: 'call-1',
          uniqueId: 'uid-1',
          direction: 'OUTBOUND',
          durationSec: 42,
          recording: 'https://rec.example/1.mp3',
          status: 'ANSWERED',
        }),
      );

      expect(prisma.salesCall.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'call-1', workspaceId: 'ws-1' } }),
      );
      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'call-1', workspaceId: 'ws-1', status: { in: ['INITIATED', 'RINGING'] } },
        data: {
          status: 'CONNECTED',
          externalCallId: 'uid-1',
          durationSec: 42,
          recordingUrl: 'https://rec.example/1.mp3',
          endedAt: expect.any(Date),
        },
      });
    });

    it('falls back to uniqueId -> externalCallId when crmId is absent', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-2',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'INITIATED',
        externalCallId: 'uid-2',
        marketingUserId: 'rep-1',
        leadId: null,
        toPhone: '05551112233',
      });

      await handle(makeEvent('evt-2', { kind: 'cdr', uniqueId: 'uid-2', crmId: null, durationSec: 0, status: 'NOANSWER' }));

      expect(prisma.salesCall.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: 'ws-1', externalCallId: 'uid-2' } }),
      );
      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'call-2', workspaceId: 'ws-1', status: { in: ['INITIATED', 'RINGING'] } } }),
      );
    });

    it('falls back to last-10-digit correlation within the window when crmId/uniqueId are both absent', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // no uniqueId given, so this branch is skipped entirely
      (prisma.salesCall.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'call-3', workspaceId: 'ws-1', direction: 'OUTBOUND', status: 'INITIATED', toPhone: '0555 111 22 33', externalCallId: null },
      ]);

      await handle(makeEvent('evt-3', { kind: 'hangup', crmId: null, uniqueId: null, customerNum: '905551112233', durationSec: 12 }));

      expect(prisma.salesCall.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws-1', direction: 'OUTBOUND', status: 'INITIATED' }) }),
      );
      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'call-3', workspaceId: 'ws-1', status: { in: ['INITIATED', 'RINGING'] } } }),
      );
    });

    it('never re-finalizes an already-terminal call (idempotent — the CDR poll or a redelivery may have gotten there first)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-4',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'CONNECTED', // already terminal in the real DB
        externalCallId: 'uid-4',
        marketingUserId: 'rep-1',
        leadId: 'lead-1',
      });
      (prisma.salesCall.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 }); // claim WHERE didn't match

      await handle(makeEvent('evt-4', { kind: 'hangup', uniqueId: 'uid-4', direction: 'INBOUND', durationSec: 0, status: 'NOANSWER' }));

      // Status monotonic: CONNECTED must not be regressed to NO_ANSWER, and the
      // missed-call side effects must never fire for a call that was already terminal.
      expect(prisma.marketingTask.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('INBOUND inbound_call — create + lead link + timeline', () => {
    it('creates an INBOUND SalesCall, resolves the rep by dahili, links the lead, and mirrors a CALL activity', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // no existing row for this uniqueId
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-1' }); // dahili match
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'lead-1', assignedToId: 'rep-1' });
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({
        id: 'call-5',
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        marketingUserId: 'rep-1',
        direction: 'INBOUND',
        status: 'RINGING',
      });

      await handle(
        makeEvent('evt-5', {
          kind: 'inbound_call',
          uniqueId: 'uid-5',
          customerNum: '05551112233',
          internalNum: '104',
          direction: 'INBOUND',
        }),
      );

      expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: 'ws-1', dahili: '104', status: 'ACTIVE' } }),
      );
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: 'ws-1', phoneNormalized: { in: ['5551112233', '05551112233', '905551112233'] }, mergedIntoId: null, deletedAt: null },
        }),
      );
      expect(prisma.salesCall.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          marketingUserId: 'rep-1',
          leadId: 'lead-1',
          direction: 'INBOUND',
          toPhone: '05551112233',
          providerId: 'netgsm-netsantral',
          status: 'RINGING',
          externalCallId: 'uid-5',
          ringingAt: expect.any(Date),
          durationSec: null,
          recordingUrl: null,
          endedAt: null,
        },
      });
      expect(prisma.leadActivity.create).toHaveBeenCalledWith({
        data: {
          type: 'CALL',
          title: 'Inbound call: RINGING',
          outcome: 'NEUTRAL',
          leadId: 'lead-1',
          createdById: 'rep-1',
        },
      });
    });

    it('unmatched extension -> marketingUserId stays null (no crash)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce(null); // no dahili match
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({
        id: 'call-6',
        workspaceId: 'ws-1',
        leadId: null,
        marketingUserId: null,
        direction: 'INBOUND',
        status: 'RINGING',
      });

      await expect(
        handle(makeEvent('evt-6', { kind: 'inbound_call', uniqueId: 'uid-6', customerNum: '05559998877', internalNum: '999' })),
      ).resolves.toBeUndefined();

      expect(prisma.salesCall.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ marketingUserId: null }) }),
      );
      expect(prisma.leadActivity.create).not.toHaveBeenCalled();
    });

    it('treats kind === inbound_call as inbound even when direction did not normalize (Task 1 MEDIUM hardening)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({ id: 'call-7', workspaceId: 'ws-1', leadId: null, marketingUserId: null });

      await handle(makeEvent('evt-7', { kind: 'inbound_call', uniqueId: 'uid-7', direction: null }));

      expect(prisma.salesCall.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ direction: 'INBOUND' }) }),
      );
    });
  });

  describe('out-of-order tolerance (upsert)', () => {
    it('a hangup arriving BEFORE inbound_call (no existing row) upserts an INBOUND row directly from the hangup event', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // correlate(): no row by uniqueId
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({
        id: 'call-8',
        workspaceId: 'ws-1',
        leadId: null,
        marketingUserId: null,
        direction: 'INBOUND',
        status: 'NO_ANSWER',
      });

      await handle(
        makeEvent('evt-8', {
          kind: 'hangup',
          uniqueId: 'uid-8',
          crmId: null,
          customerNum: '05559998877',
          internalNum: null,
          direction: 'INBOUND',
          durationSec: 0,
          status: 'NOANSWER',
        }),
      );

      expect(prisma.salesCall.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: 'INBOUND',
            status: 'NO_ANSWER',
            externalCallId: 'uid-8',
            endedAt: expect.any(Date),
          }),
        }),
      );
      // Missed-call side effects fire even on this upsert-creation path.
      expect(outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: MarketingEventTypes.CallMissed, payload: expect.objectContaining({ salesCallId: 'call-8' }) }),
      );
    });

    it('a redelivered/out-of-order inbound_call against an already-upserted row fills blanks but never regresses status', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-9',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'NO_ANSWER', // already terminal from the earlier out-of-order hangup
        externalCallId: 'uid-9',
        marketingUserId: null,
        ringingAt: null,
      });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-9' });

      await handle(makeEvent('evt-9', { kind: 'inbound_call', uniqueId: 'uid-9', internalNum: '104', direction: 'INBOUND' }));

      // Blank-fill only: marketingUserId + ringingAt get backfilled...
      expect(prisma.salesCall.update).toHaveBeenCalledWith({
        where: { id: 'call-9' },
        data: { marketingUserId: 'rep-9', ringingAt: expect.any(Date) },
      });
      // ...but status is never touched by this path.
      expect(prisma.salesCall.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('missed call', () => {
    it('an inbound hangup with no answer -> NO_ANSWER, creates a follow-up task, and emits marketing.call.missed.v1', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-10',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'RINGING',
        externalCallId: 'uid-10',
        marketingUserId: 'rep-10',
        leadId: 'lead-10',
      });

      await handle(
        makeEvent('evt-10', {
          kind: 'hangup',
          uniqueId: 'uid-10',
          customerNum: '05551112233',
          direction: 'INBOUND',
          durationSec: 0,
          status: 'NOANSWER',
        }),
      );

      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'NO_ANSWER' }) }),
      );
      expect(prisma.marketingTask.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          title: 'Missed call: 05551112233',
          type: 'FOLLOW_UP',
          dueDate: expect.any(Date),
          assignedToId: 'rep-10',
          leadId: 'lead-10',
        },
      });
      expect(outbox.append).toHaveBeenCalledWith({
        type: MarketingEventTypes.CallMissed,
        tenantId: null,
        idempotencyKey: 'call-missed:call-10',
        payload: { workspaceId: 'ws-1', salesCallId: 'call-10', leadId: 'lead-10', customerNum: '05551112233' },
      });
    });

    it('assignee fallback: no rep on the call -> the lead owner -> auto-assign; skips the task (but still emits the event) when nothing resolves', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-11',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'RINGING',
        externalCallId: 'uid-11',
        marketingUserId: null,
        leadId: null,
      });

      await handle(makeEvent('evt-11', { kind: 'hangup', uniqueId: 'uid-11', direction: 'INBOUND', durationSec: 0 }));

      expect(autoAssigner.pickAssignee).toHaveBeenCalledWith('ws-1');
      expect(prisma.marketingTask.create).not.toHaveBeenCalled();
      expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({ type: MarketingEventTypes.CallMissed }));
    });
  });

  describe('answer', () => {
    it('bumps a correlated call to CONNECTED and stamps answeredByUserId', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-12',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'RINGING',
        externalCallId: 'uid-12',
        answeredByUserId: null,
      });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-12' });

      await handle(makeEvent('evt-12', { kind: 'answer', uniqueId: 'uid-12', internalNum: '104' }));

      expect(prisma.salesCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'call-12', workspaceId: 'ws-1', status: { in: ['INITIATED', 'RINGING'] } },
        data: { status: 'CONNECTED', answeredByUserId: 'rep-12', externalCallId: 'uid-12' },
      });
    });

    it('no-ops when nothing correlates (no crash)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null);

      await expect(handle(makeEvent('evt-13', { kind: 'answer', uniqueId: 'uid-none' }))).resolves.toBeUndefined();
      expect(prisma.salesCall.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('dedupes a replayed event id — the same id is only processed once', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValue({
        id: 'call-14',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'INITIATED',
        externalCallId: null,
      });

      const event = makeEvent('evt-dup', { kind: 'hangup', crmId: 'call-14', durationSec: 5 });
      await handle(event);
      await handle(event);

      expect(prisma.salesCall.updateMany).toHaveBeenCalledTimes(1);
    });

    it('never throws when workspaceId is missing from the payload', async () => {
      await expect(handle(makeEvent('evt-15', { workspaceId: undefined as unknown as string }))).resolves.toBeUndefined();
      expect(prisma.salesCall.findFirst).not.toHaveBeenCalled();
    });

    it('logs and skips an unrecognized kind rather than throwing', async () => {
      await expect(handle(makeEvent('evt-16', { kind: 'garbage' as any }))).resolves.toBeUndefined();
      expect(prisma.salesCall.findFirst).not.toHaveBeenCalled();
    });
  });
});
