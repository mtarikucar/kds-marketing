import { Prisma } from '@prisma/client';
import { TelephonyEventConsumer } from './telephony-event.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingCallEventPayload } from '../events/marketing-event-types';

/** Real PrismaClientKnownRequestError instance — the production code checks
 *  `instanceof`, so a plain `{ code: 'P2002' }` object would NOT be caught
 *  (mirrors settlement-commission.consumer.spec.ts's identical idiom). */
const p2002 = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' } as any);

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
  let telephonyStream: { push: jest.Mock };
  let svc: TelephonyEventConsumer;

  const handle = (e: DomainEvent<MarketingCallEventPayload>) => (svc as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    outbox = { append: jest.fn().mockResolvedValue('evt-out-1') };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    telephonyStream = { push: jest.fn() };
    svc = new TelephonyEventConsumer(prisma as any, bus as any, outbox as any, autoAssigner as any, telephonyStream as any);

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

    it('never regresses an already-CONNECTED call\'s STATUS, and never re-fires missed-call side effects for it (status monotonic — HIGH-1 blank-fill is a separate concern, covered below)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-4',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'CONNECTED', // already terminal in the real DB
        externalCallId: 'uid-4',
        marketingUserId: 'rep-1',
        leadId: 'lead-1',
      });
      (prisma.salesCall.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 0 }) // claim (a): status not IN (INITIATED, RINGING) — no match
        .mockResolvedValueOnce({ count: 1 }) // HIGH-1 blank-fill: endedAt was null — filled now
        .mockResolvedValueOnce({ count: 1 }); // durationSec (0, still != null) blank-fill

      await handle(makeEvent('evt-4', { kind: 'hangup', uniqueId: 'uid-4', direction: 'INBOUND', durationSec: 0, status: 'NOANSWER' }));

      // Status monotonic: CONNECTED must never be regressed to NO_ANSWER (the
      // claim(a) WHERE never matches a CONNECTED row), and the missed-call
      // side effects — scoped strictly to the claim(a) branch — must never
      // fire for a call that was already answered.
      expect(prisma.marketingTask.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
      // The blank-fill DID run (HIGH-1 fix) — this is the ENDED pill, not a
      // status regression. No marketingUser.findFirst mock configured here ->
      // resolves undefined -> resolveTargetDahili falls back to the event's
      // own (absent) internal_num -> null (broadcast).
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: null,
        payload: { salesCallId: 'call-4', status: 'ENDED' },
      });
    });
  });

  describe('INBOUND inbound_call — create + lead link + timeline', () => {
    it('creates an INBOUND SalesCall, resolves the rep by dahili, links the lead, and mirrors a CALL activity', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // no existing row for this uniqueId
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-1' }); // dahili match
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'lead-1',
        assignedToId: 'rep-1',
        businessName: 'Cafe Deniz',
        contactPerson: 'Ayşe Yılmaz',
        phone: '05551112233',
        status: 'CONTACTED',
      });
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
      // Screen-pop (Task 3): pushed onto the workspace's telephony stream,
      // routed by internal_num, carrying a compact lead card + the SalesCall id.
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'screen_pop',
        targetDahili: '104',
        payload: {
          customerNum: '05551112233',
          lead: {
            id: 'lead-1',
            businessName: 'Cafe Deniz',
            contactPerson: 'Ayşe Yılmaz',
            phone: '05551112233',
            status: 'CONTACTED',
          },
          salesCallId: 'call-5',
          internalNum: '104',
        },
      });
    });

    it('unmatched extension -> marketingUserId stays null (no crash), and the screen-pop still fires with lead: null (no rep owns the extension, but the call itself is still worth surfacing)', async () => {
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
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'screen_pop',
        targetDahili: '999',
        payload: { customerNum: '05559998877', lead: null, salesCallId: 'call-6', internalNum: '999' },
      });
    });

    it('an UNROUTED inbound (no internal_num) broadcasts a screen-pop with a TRIMMED lead card (no phone/status leaked to every rep)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce(null); // no dahili to resolve
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'lead-9',
        assignedToId: 'rep-2',
        businessName: 'Cafe Deniz',
        contactPerson: 'Ayşe Yılmaz',
        phone: '05551112233',
        status: 'CONTACTED',
      });
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({
        id: 'call-9',
        workspaceId: 'ws-1',
        leadId: 'lead-9',
        marketingUserId: null,
        direction: 'INBOUND',
        status: 'RINGING',
      });

      await handle(
        makeEvent('evt-9', { kind: 'inbound_call', uniqueId: 'uid-9', customerNum: '05551112233', internalNum: null }),
      );

      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'screen_pop',
        targetDahili: null, // broadcast to every rep in the workspace
        payload: {
          customerNum: '05551112233',
          // trimmed: only what a rep needs to greet the caller — NO phone (== customerNum) and NO CRM `status`
          lead: { id: 'lead-9', businessName: 'Cafe Deniz', contactPerson: 'Ayşe Yılmaz' },
          salesCallId: 'call-9',
          internalNum: null,
        },
      });
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
      // No screen-pop — this call already ended by the time this out-of-order
      // hangup created the row; there is nothing left to "pop". It DOES still
      // get a call_status push (Task 6) — the rep's live pill still deserves
      // to see the terminal state, even for a call whose row was born already
      // ended (no marketingUserId here, so it falls back to the event's own
      // internal_num, which is null too -> broadcast).
      expect(telephonyStream.push).toHaveBeenCalledTimes(1);
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: null,
        payload: { salesCallId: 'call-8', status: 'NO_ANSWER' },
      });
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
      // A redelivery of a call already surfaced never re-pops it.
      expect(telephonyStream.push).not.toHaveBeenCalled();
    });
  });

  describe('concurrent-insert race (MEDIUM follow-up — DB-atomic guard)', () => {
    it('inbound_call create losing the race to a P2002 re-fetches the winner row and skips lead-activity/missed-call side effects', async () => {
      (prisma.salesCall.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // handleInboundCall's pre-check: no existing row yet
        .mockResolvedValueOnce({
          // createOrGetInbound's post-P2002 re-fetch: the winner's row
          id: 'call-winner',
          workspaceId: 'ws-1',
          leadId: 'lead-1',
          marketingUserId: 'rep-1',
          direction: 'INBOUND',
          status: 'RINGING',
          externalCallId: 'uid-race',
        });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-1' });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'lead-1', assignedToId: 'rep-1' });
      (prisma.salesCall.create as jest.Mock).mockRejectedValueOnce(p2002());

      await handle(
        makeEvent('evt-race-1', {
          kind: 'inbound_call',
          uniqueId: 'uid-race',
          customerNum: '05551112233',
          internalNum: '104',
        }),
      );

      expect(prisma.salesCall.findFirst).toHaveBeenNthCalledWith(2, { where: { workspaceId: 'ws-1', externalCallId: 'uid-race' } });
      // The loser never mirrors a lead activity or fires a missed-call
      // follow-up/event — only the winning insert (elsewhere) does that.
      expect(prisma.leadActivity.create).not.toHaveBeenCalled();
      expect(prisma.marketingTask.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
      // ...nor a second screen-pop for the same physical call.
      expect(telephonyStream.push).not.toHaveBeenCalled();
    });

    it('the out-of-order hangup/cdr upsert path losing the race to a P2002 also re-fetches and skips duplicate side effects', async () => {
      (prisma.salesCall.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // correlate(): no row by uniqueId (no crmId given)
        .mockResolvedValueOnce({
          // createOrGetInbound's post-P2002 re-fetch: the winner's row (the
          // concurrent inbound_call event's create already fired the missed
          // call handling for it — this event must NOT fire it again)
          id: 'call-winner-2',
          workspaceId: 'ws-1',
          leadId: null,
          marketingUserId: null,
          direction: 'INBOUND',
          status: 'NO_ANSWER',
          externalCallId: 'uid-race-2',
        });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.salesCall.create as jest.Mock).mockRejectedValueOnce(p2002());

      await handle(
        makeEvent('evt-race-2', {
          kind: 'hangup',
          uniqueId: 'uid-race-2',
          crmId: null,
          customerNum: '05559998877',
          direction: 'INBOUND',
          durationSec: 0,
          status: 'NOANSWER',
        }),
      );

      expect(prisma.salesCall.findFirst).toHaveBeenNthCalledWith(2, { where: { workspaceId: 'ws-1', externalCallId: 'uid-race-2' } });
      expect(prisma.marketingTask.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('re-throws a non-P2002 create error rather than swallowing it', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce(null);
      const boom = new Error('connection lost');
      (prisma.salesCall.create as jest.Mock).mockRejectedValueOnce(boom);

      await expect((svc as any).createInboundCall('ws-1', { uniqueId: 'uid-x', customerNum: null, internalNum: null }, 'RINGING')).rejects.toThrow(
        'connection lost',
      );
    });

    it('re-throws P2002 when the re-fetch itself somehow finds nothing (defensive — should not happen in practice)', async () => {
      const err = p2002();
      (prisma.salesCall.create as jest.Mock).mockRejectedValueOnce(err);
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // re-fetch finds nothing

      await expect(
        (svc as any).createOrGetInbound('ws-1', { uniqueId: 'uid-y', customerNum: null, internalNum: null }, 'RINGING', null, null),
      ).rejects.toBe(err);
    });

    it('the normal single-create path is unchanged: created:true, no re-fetch, side effects fire once', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // handleInboundCall pre-check
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-1' });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'lead-1', assignedToId: 'rep-1' });
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({
        id: 'call-normal',
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        marketingUserId: 'rep-1',
        direction: 'INBOUND',
        status: 'RINGING',
      });

      await handle(
        makeEvent('evt-normal', {
          kind: 'inbound_call',
          uniqueId: 'uid-normal',
          customerNum: '05551112233',
          internalNum: '104',
        }),
      );

      // Only ONE findFirst call (the pre-check) — no P2002 re-fetch.
      expect(prisma.salesCall.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.leadActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ leadId: 'lead-1' }) }),
      );
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

  describe('call_status SSE push (Task 6 — live status pill)', () => {
    it('answer -> pushes call_status CONNECTED, targetDahili resolved from the call\'s OWN rep (marketingUserId -> MarketingUser.dahili)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-20',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'INITIATED',
        externalCallId: 'uid-20',
        marketingUserId: 'rep-20',
        answeredByUserId: null,
      });
      // First findFirst call is handleAnswer's own answeredBy lookup (by
      // internal_num); the SECOND is pushCallStatus's resolveTargetDahili
      // lookup (by the call's marketingUserId).
      (prisma.marketingUser.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'rep-20' })
        .mockResolvedValueOnce({ dahili: '210' });

      await handle(makeEvent('evt-20', { kind: 'answer', uniqueId: 'uid-20', internalNum: '999' }));

      expect(prisma.marketingUser.findFirst).toHaveBeenNthCalledWith(2, {
        where: { id: 'rep-20', workspaceId: 'ws-1' },
        select: { dahili: true },
      });
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: '210', // the REP's own dahili, not the event's internal_num ('999')
        payload: { salesCallId: 'call-20', status: 'CONNECTED' },
      });
    });

    it('answer -> falls back to the event\'s internal_num when the call has no attributed rep', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-21',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'RINGING',
        externalCallId: 'uid-21',
        marketingUserId: null,
        answeredByUserId: null,
      });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce(null); // answeredBy lookup: no match

      await handle(makeEvent('evt-21', { kind: 'answer', uniqueId: 'uid-21', internalNum: '104' }));

      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: '104',
        payload: { salesCallId: 'call-21', status: 'CONNECTED' },
      });
    });

    it('answer -> does NOT push when the call is already terminal (no-op claim)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-22',
        workspaceId: 'ws-1',
        status: 'CONNECTED',
        marketingUserId: 'rep-22',
      });
      (prisma.salesCall.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

      await handle(makeEvent('evt-22', { kind: 'answer', uniqueId: 'uid-22', internalNum: '104' }));

      expect(telephonyStream.push).not.toHaveBeenCalled();
    });

    it('hangup/cdr -> pushes call_status with the final terminal status once the claim actually flips the call', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-23',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'INITIATED',
        externalCallId: 'uid-23',
        marketingUserId: 'rep-23',
      });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ dahili: '230' });

      await handle(makeEvent('evt-23', { kind: 'hangup', uniqueId: 'uid-23', durationSec: 30, status: 'ANSWERED' }));

      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: '230',
        payload: { salesCallId: 'call-23', status: 'CONNECTED' },
      });
    });

    it('hangup/cdr -> does NOT push when a REDELIVERED event finds the call fully finalized already (endedAt/durationSec/recordingUrl all non-null — HIGH-1 idempotency: no double-write, no double-pill)', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-24',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'CONNECTED',
        marketingUserId: 'rep-24',
      });
      (prisma.salesCall.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 0 }) // claim (a): not INITIATED/RINGING
        .mockResolvedValueOnce({ count: 0 }) // endedAt blank-fill: already non-null (redelivery)
        .mockResolvedValueOnce({ count: 0 }); // durationSec blank-fill: already non-null

      await handle(makeEvent('evt-24', { kind: 'hangup', crmId: 'call-24', durationSec: 0, status: 'NOANSWER' }));

      expect(telephonyStream.push).not.toHaveBeenCalled();
    });

    it('an answered call\'s hangup is discovered blank-fill (HIGH-1 core fix): CONNECTED row with a null endedAt gets endedAt/durationSec/recordingUrl filled and pushes an ENDED pill', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-30',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'CONNECTED', // already flipped by an earlier 'answer' event
        externalCallId: 'uid-30',
        marketingUserId: 'rep-30',
        answeredByUserId: 'rep-30',
      });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ dahili: '301' });
      (prisma.salesCall.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 0 }) // claim (a): CONNECTED is not INITIATED/RINGING
        .mockResolvedValueOnce({ count: 1 }) // endedAt was null -> filled
        .mockResolvedValueOnce({ count: 1 }) // durationSec was null -> filled
        .mockResolvedValueOnce({ count: 1 }); // recordingUrl was null -> filled

      await handle(
        makeEvent('evt-30', {
          kind: 'hangup',
          crmId: 'call-30',
          durationSec: 42,
          recording: 'https://rec.example/30.mp3',
          status: 'ANSWERED',
        }),
      );

      expect(prisma.salesCall.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'call-30', workspaceId: 'ws-1', status: { in: ['INITIATED', 'RINGING'] } },
        data: {
          status: 'CONNECTED',
          externalCallId: 'uid-30',
          durationSec: 42,
          recordingUrl: 'https://rec.example/30.mp3',
          endedAt: expect.any(Date),
        },
      });
      expect(prisma.salesCall.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'call-30', workspaceId: 'ws-1', status: 'CONNECTED', endedAt: null },
        data: { endedAt: expect.any(Date) },
      });
      expect(prisma.salesCall.updateMany).toHaveBeenNthCalledWith(3, {
        where: { id: 'call-30', workspaceId: 'ws-1', status: 'CONNECTED', durationSec: null },
        data: { durationSec: 42 },
      });
      expect(prisma.salesCall.updateMany).toHaveBeenNthCalledWith(4, {
        where: { id: 'call-30', workspaceId: 'ws-1', status: 'CONNECTED', recordingUrl: null },
        data: { recordingUrl: 'https://rec.example/30.mp3' },
      });
      // The terminal pill: 'ENDED', not 'CONNECTED' again (that pill already
      // fired once, from the earlier 'answer' event) — this is the NEW
      // signal telling the rep's UI the call is actually over now.
      expect(telephonyStream.push).toHaveBeenCalledTimes(1);
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: '301',
        payload: { salesCallId: 'call-30', status: 'ENDED' },
      });
    });

    it('a bare hangup (no bilsec/recording) followed by a cdr (bilsec + recording) fills duration/recording from the cdr without a second pill', async () => {
      const callSnapshot = {
        id: 'call-31',
        workspaceId: 'ws-1',
        direction: 'OUTBOUND',
        status: 'CONNECTED',
        externalCallId: 'uid-31',
        marketingUserId: 'rep-31',
      };

      // Event 1: hangup, no duration/recording carried — only endedAt fills.
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(callSnapshot);
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ dahili: '311' });
      (prisma.salesCall.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 0 }) // claim (a): no match, CONNECTED
        .mockResolvedValueOnce({ count: 1 }); // endedAt was null -> filled now
      // durationSec/recordingUrl are both null in the payload -> no fill calls attempted.

      await handle(makeEvent('evt-31a', { kind: 'hangup', crmId: 'call-31', durationSec: null, recording: null }));

      expect(prisma.salesCall.updateMany).toHaveBeenCalledTimes(2);
      expect(telephonyStream.push).toHaveBeenCalledTimes(1);
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: '311',
        payload: { salesCallId: 'call-31', status: 'ENDED' },
      });

      // Event 2: the cdr sweep/webhook arrives later with the real duration +
      // recording — endedAt is already set by event 1, so this is a
      // fill-only pass: no second pill (and so no second resolveTargetDahili
      // lookup either — no marketingUser.findFirst mock needed here).
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(callSnapshot);
      (prisma.salesCall.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 0 }) // claim (a): still no match
        .mockResolvedValueOnce({ count: 0 }) // endedAt: already non-null from event 1
        .mockResolvedValueOnce({ count: 1 }) // durationSec: was null -> filled from cdr
        .mockResolvedValueOnce({ count: 1 }); // recordingUrl: was null -> filled from cdr

      await handle(makeEvent('evt-31b', { kind: 'cdr', crmId: 'call-31', durationSec: 42, recording: 'https://rec.example/31.mp3' }));

      // Event 2's 4 calls (claim, endedAt-fill, durationSec-fill,
      // recordingUrl-fill) are calls #3-6 overall (event 1 used #1-2).
      expect(prisma.salesCall.updateMany).toHaveBeenNthCalledWith(5, {
        where: { id: 'call-31', workspaceId: 'ws-1', status: 'CONNECTED', durationSec: null },
        data: { durationSec: 42 },
      });
      expect(prisma.salesCall.updateMany).toHaveBeenNthCalledWith(6, {
        where: { id: 'call-31', workspaceId: 'ws-1', status: 'CONNECTED', recordingUrl: null },
        data: { recordingUrl: 'https://rec.example/31.mp3' },
      });
      // Still only ONE pill push total — event 2 never re-ends an already-ended call.
      expect(telephonyStream.push).toHaveBeenCalledTimes(1);
    });
  });

  describe('dahili trunk-suffix tolerance (MEDIUM-2)', () => {
    it('resolves the rep by the BARE dahili when internal_num carries the full <dahili>-<trunk> form', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce(null); // no existing row for this uniqueId
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'rep-101' }); // dahili match
      (prisma.lead.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.salesCall.create as jest.Mock).mockResolvedValueOnce({
        id: 'call-40',
        workspaceId: 'ws-1',
        leadId: null,
        marketingUserId: 'rep-101',
        direction: 'INBOUND',
        status: 'RINGING',
      });

      await handle(
        makeEvent('evt-40', {
          kind: 'inbound_call',
          uniqueId: 'uid-40',
          customerNum: '05551112233',
          internalNum: '101-8508407303', // NetGSM's full dahili-trunk form
          direction: 'INBOUND',
        }),
      );

      // The rep-resolve query matches the BARE dahili ('101'), not the raw
      // suffixed internal_num.
      expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: 'ws-1', dahili: '101', status: 'ACTIVE' } }),
      );
      // The screen-pop also targets the stripped, bare dahili — the rep's own
      // SSE stream filters on their bare MarketingUser.dahili.
      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'screen_pop',
        targetDahili: '101',
        payload: {
          customerNum: '05551112233',
          lead: null,
          salesCallId: 'call-40',
          internalNum: '101-8508407303', // raw form preserved for display/debug
        },
      });
    });

    it('resolveTargetDahili\'s no-marketingUserId fallback also strips the trunk suffix before routing the call_status pill', async () => {
      (prisma.salesCall.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'call-41',
        workspaceId: 'ws-1',
        direction: 'INBOUND',
        status: 'RINGING',
        externalCallId: 'uid-41',
        marketingUserId: null, // no attributed rep -> resolveTargetDahili falls back to internal_num
        answeredByUserId: null,
      });
      (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValueOnce(null); // answeredBy lookup: no dahili match either

      await handle(makeEvent('evt-41', { kind: 'answer', uniqueId: 'uid-41', internalNum: '101-8508407303' }));

      expect(telephonyStream.push).toHaveBeenCalledWith('ws-1', {
        kind: 'call_status',
        targetDahili: '101', // stripped, not the raw '101-8508407303'
        payload: { salesCallId: 'call-41', status: 'CONNECTED' },
      });
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
