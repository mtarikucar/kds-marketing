import { AutocallReportConsumer } from './autocall-report.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingAutocallReportPayload } from '../events/marketing-event-types';

function makeEvent(id: string, overrides: Partial<MarketingAutocallReportPayload> = {}): DomainEvent<MarketingAutocallReportPayload> {
  const payload: MarketingAutocallReportPayload = {
    workspaceId: 'ws-1',
    jobId: 'job-1',
    called: '905551112233',
    uniqueId: 'attempt-1',
    status: 'ANSWERED',
    ...overrides,
  };
  return {
    id,
    type: MarketingEventTypes.AutocallReport,
    tenantId: null,
    idempotencyKey: id,
    createdAt: new Date('2026-07-09T10:00:00.000Z'),
    payload,
  };
}

const SESSION = { id: 'sess-1' };

/**
 * AutocallReportConsumer correlates by jobId == AutocallSession.netgsmListId
 * (workspace-scoped), then matches `called` to ONE AutocallSessionItem by
 * phone (reconciling every known Turkish-mobile spelling), and writes
 * lastAttemptStatus/lastUniqueId/attemptedAt — always the MOST RECENT
 * attempt only. The behaviors that matter most:
 *  - unknown jobId is skipped, never guessed at;
 *  - an unmatched `called` is skipped, never falls back to "the only item";
 *  - phone matching tolerates 0-prefixed / 90-prefixed / bare-10-digit spellings;
 *  - event.id dedupe guards a redispatch;
 *  - a later attempt overwrites the previous one (no history kept).
 */
describe('AutocallReportConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock; off: jest.Mock };
  let svc: AutocallReportConsumer;

  const handle = (e: DomainEvent<MarketingAutocallReportPayload>) => (svc as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    svc = new AutocallReportConsumer(prisma as any, bus as any);
    (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(SESSION);
    (prisma.autocallSessionItem.findMany as jest.Mock).mockResolvedValue([
      { id: 'it-1', phone: '905551112233' },
      { id: 'it-2', phone: '905551112244' },
    ]);
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('subscribes on init and detaches the SAME handler ref on destroy', () => {
      svc.onModuleInit();
      expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.AutocallReport, expect.any(Function));
      const registered = bus.on.mock.calls[0][1];
      svc.onModuleDestroy();
      expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.AutocallReport, registered);
    });
  });

  describe('handle', () => {
    it('correlates by jobId == AutocallSession.netgsmListId (workspace-scoped)', async () => {
      await handle(makeEvent('evt-1'));
      expect(prisma.autocallSession.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', netgsmListId: 'job-1' },
        select: { id: true },
      });
    });

    it('matches `called` to the item by exact phone and writes the attempt outcome', async () => {
      await handle(makeEvent('evt-1', { called: '905551112233', uniqueId: 'attempt-1', status: 'ANSWERED' }));
      expect(prisma.autocallSessionItem.update).toHaveBeenCalledWith({
        where: { id: 'it-1' },
        data: { lastAttemptStatus: 'ANSWERED', lastUniqueId: 'attempt-1', attemptedAt: expect.any(Date) },
      });
    });

    it('reconciles a different phone spelling (0-prefixed vs 90-prefixed vs bare)', async () => {
      await handle(makeEvent('evt-1', { called: '05551112233' })); // 0-prefixed spelling of item it-1's 90-prefixed phone
      expect(prisma.autocallSessionItem.update).toHaveBeenCalledWith({
        where: { id: 'it-1' },
        data: expect.objectContaining({ lastAttemptStatus: 'ANSWERED' }),
      });
    });

    it('a retried number gets a NEW attempt — the latest one overwrites (no history kept)', async () => {
      await handle(makeEvent('evt-1', { called: '905551112233', uniqueId: 'attempt-1', status: 'NO_ANSWER' }));
      await handle(makeEvent('evt-2', { called: '905551112233', uniqueId: 'attempt-2', status: 'ANSWERED' }));
      expect(prisma.autocallSessionItem.update).toHaveBeenCalledTimes(2);
      expect((prisma.autocallSessionItem.update as jest.Mock).mock.calls[1][0].data).toMatchObject({
        lastAttemptStatus: 'ANSWERED', lastUniqueId: 'attempt-2',
      });
    });

    it('an unknown jobId is skipped — never writes anything', async () => {
      (prisma.autocallSession.findFirst as jest.Mock).mockResolvedValue(null);
      await handle(makeEvent('evt-1', { jobId: 'no-such-job' }));
      expect(prisma.autocallSessionItem.findMany).not.toHaveBeenCalled();
      expect(prisma.autocallSessionItem.update).not.toHaveBeenCalled();
    });

    it('an unmatched `called` is skipped — never guesses at the only item', async () => {
      await handle(makeEvent('evt-1', { called: '905559999999' }));
      expect(prisma.autocallSessionItem.update).not.toHaveBeenCalled();
    });

    it('a missing `called` is skipped without querying items', async () => {
      await handle(makeEvent('evt-1', { called: null }));
      expect(prisma.autocallSessionItem.findMany).not.toHaveBeenCalled();
      expect(prisma.autocallSessionItem.update).not.toHaveBeenCalled();
    });

    it('a missing workspaceId/jobId is skipped without any DB read', async () => {
      await handle(makeEvent('evt-1', { jobId: undefined as any }));
      expect(prisma.autocallSession.findFirst).not.toHaveBeenCalled();
    });

    it('dedupes on event.id — a redispatch of the SAME event is processed only once', async () => {
      const evt = makeEvent('evt-dup');
      await handle(evt);
      await handle(evt);
      expect(prisma.autocallSessionItem.update).toHaveBeenCalledTimes(1);
    });

    it('a missing status/uniqueId is written as null, not dropped', async () => {
      await handle(makeEvent('evt-1', { status: null, uniqueId: null }));
      expect(prisma.autocallSessionItem.update).toHaveBeenCalledWith({
        where: { id: 'it-1' },
        data: { lastAttemptStatus: null, lastUniqueId: null, attemptedAt: expect.any(Date) },
      });
    });
  });
});
