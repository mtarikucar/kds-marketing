import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SalesCall } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes, MarketingCallEventPayload } from '../events/marketing-event-types';
import { localMsisdnVariants, normalizePhone } from '../utils/lead-normalize';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';

/** A call is still "in flight" in exactly these two statuses; anything else is terminal. */
const NON_TERMINAL_STATUSES = ['INITIATED', 'RINGING'];

/**
 * Telephony event consumer (NetGSM Phase 3 Task 2). Subscribes
 * `marketing.telephony.call_event.v1` (published by NetgsmEventsController's
 * `events` route from a normalized santral scenario push — see
 * `santral-event-normalizer.ts`) and:
 *
 *  - OUTBOUND hangup/cdr: correlates back to the SalesCall the rep started
 *    via SalesCallService.startCall (crmId FIRST since it IS our SalesCall.id
 *    — the strongest possible signal — then the santral uniqueId once
 *    backfilled onto externalCallId, then a last-10-digit match within a
 *    correlation window, mirroring CallCdrSyncService's own fallback). Stamps
 *    the terminal status/duration/recording/endedAt and backfills
 *    externalCallId. This REPLACES the fragile poll-only correlation the CDR
 *    sweep used to be the only source of; that sweep keeps running as a
 *    reconciliation backstop for calls this consumer never hears about (e.g.
 *    the santral webhook URL isn't registered yet), so every write here is
 *    guarded to never re-finalize an already-terminal call (see
 *    `finalizeCall`'s atomic claim) — whichever of {this consumer, the CDR
 *    poll} gets there first wins, the other is a no-op.
 *
 *  - INBOUND inbound_call/hangup/cdr: creates (or upserts by externalCallId,
 *    tolerating hangup/cdr arriving before inbound_call — a real possibility
 *    given the events route's per-scenario archive/publish and the bus's
 *    at-least-once, order-non-guaranteed delivery) an INBOUND SalesCall.
 *    `marketingUserId` resolves from internal_num -> MarketingUser.dahili and
 *    is left null when unmatched (an inbound call to an unowned extension is
 *    still worth a row). The lead lookup reuses the SAME canonical phone-
 *    variant util IysWebhookConsumer already uses
 *    (`localMsisdnVariants`/`normalizePhone` from `../utils/lead-normalize`)
 *    rather than forking a third copy of that logic. A linked lead gets a
 *    CALL LeadActivity mirror, attributed to the resolved rep or — absent
 *    one — the workspace's SYSTEM sentinel user (same idiom as
 *    ConversationIngressService/FormsService), skipped entirely if neither
 *    exists (LeadActivity.createdById is NOT NULL).
 *
 *  - MISSED CALL: an inbound call whose terminal status resolves to
 *    NO_ANSWER (no duration, and/or a status token that isn't
 *    busy/fail/answer — see `terminalStatusFor`) creates a 2-hour FOLLOW_UP
 *    MarketingTask (assignee: the call's rep, else the lead's owner, else
 *    auto-assign — same fallback chain WorkflowActionHandler.createTask
 *    uses) and emits `marketing.call.missed.v1` so a future workflow trigger
 *    can react (see that event's docstring in marketing-event-types.ts for
 *    the TRIGGER_EVENT_MAP wiring note).
 *
 * HARDENED INBOUND DETECTION (Task 1 MEDIUM follow-up): Task 1's
 * `normalizeSantralEvent` only recognizes `yon`/`direction` values that
 * literally start with "in"/"out" — a real santral payload using Turkish
 * tokens (GELEN/GİDEN) or a numeric code would normalize to `direction: null`
 * and silently fall through to the OUTBOUND correlation path (wrong —
 * possibly matching an unrelated in-flight dial by last-10-digit coincidence,
 * or just getting dropped). `isInbound()` below trusts `kind ===
 * 'inbound_call'` as an independent, scenario-level signal that can never be
 * ambiguous (santral only ever fires that scenario for a call ARRIVING at
 * the PBX) — so a call is treated as inbound if EITHER `kind ===
 * 'inbound_call'` OR `direction === 'INBOUND'`, never relying on `direction`
 * alone.
 *
 * IDEMPOTENCY, three layers:
 *  - `DomainEvent.id` dedupe (bounded in-memory Set — same idiom as
 *    IysWebhookConsumer/NetgsmBlacklistSyncService) guards the outbox
 *    worker's orphan-reclaim sweep re-dispatching the same row.
 *  - Monotonic status guard: every status-changing write goes through an
 *    atomic `updateMany` claim scoped to `status IN
 *    ('INITIATED','RINGING')` — a call already CONNECTED/NO_ANSWER/BUSY/
 *    FAILED/CANCELLED can never be regressed (a late RINGING after CONNECTED,
 *    a redelivered hangup, a cdr the CDR poll already consumed — all no-op).
 *  - Blank-fill only for redelivered/out-of-order `inbound_call` events
 *    against an already-created row (`fillInboundBlanks`) — never touches
 *    status.
 */
@Injectable()
export class TelephonyEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelephonyEventConsumer.name);

  /** Bounded dedup cache; oldest entries evicted once the cap is hit — mirrors
   *  IysWebhookConsumer/NetgsmBlacklistSyncService's seenEventIds idiom. */
  private static readonly MAX_SEEN_IDS = 2_000;
  private readonly seenEventIds = new Set<string>();

  /** Per-workspace SYSTEM-user cache for LeadActivity attribution — mirrors
   *  ConversationIngressService/FormsService's resolveSentinel idiom. */
  private readonly sentinelCache = new Map<string, string | null>();

  /** Last-10-digit outbound correlation window — mirrors
   *  CallCdrSyncService.WINDOW_HOURS (the reconciliation backstop this
   *  consumer is meant to make mostly unnecessary, so the windows agree). */
  private static readonly CORRELATION_WINDOW_HOURS = 12;

  // v3.0.1 round-4 audit fix idiom (see SettlementCommissionConsumer /
  // IysWebhookConsumer) — a stable handler ref so onModuleDestroy can detach
  // it; an inline closure registered once but never removed leaks across
  // HMR/test teardown.
  private readonly callEventHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingCallEventPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly outbox: OutboxService,
    private readonly autoAssigner: LeadAutoAssignerService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.CallEvent, this.callEventHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.CallEvent, this.callEventHandler);
  }

  private async handle(event: DomainEvent<MarketingCallEventPayload>): Promise<void> {
    if (this.seenEventIds.has(event.id)) return; // already processed (replay)
    this.remember(event.id);

    const p = event.payload ?? ({} as MarketingCallEventPayload);
    if (!p.workspaceId) {
      this.logger.warn(`telephony call event ${event.id} missing workspaceId — skipping`);
      return;
    }

    switch (p.kind) {
      case 'inbound_call':
        await this.handleInboundCall(p.workspaceId, p);
        break;
      case 'answer':
        await this.handleAnswer(p.workspaceId, p);
        break;
      case 'hangup':
      case 'cdr':
        await this.handleTerminal(p.workspaceId, p);
        break;
      default:
        this.logger.warn(`telephony call event ${event.id}: unrecognized kind '${p.kind}' — skipping`);
    }
  }

  // ---------------------------------------------------------------------
  // inbound_call — create, or fill blanks on an already-upserted row.
  // ---------------------------------------------------------------------

  private async handleInboundCall(workspaceId: string, p: MarketingCallEventPayload): Promise<void> {
    if (!p.uniqueId) {
      this.logger.warn(`inbound_call event for workspace=${workspaceId} has no uniqueId — cannot correlate/create, skipping`);
      return;
    }
    const existing = await this.prisma.salesCall.findFirst({ where: { workspaceId, externalCallId: p.uniqueId } });
    if (existing) {
      // Redelivery, OR a hangup/cdr for this uniqueId arrived first
      // (out-of-order) and already upserted the row via createInboundCall
      // below — fill blanks only, never regress status/ringingAt.
      await this.fillInboundBlanks(existing, p);
      return;
    }
    await this.createInboundCall(workspaceId, p, 'RINGING');
  }

  private async fillInboundBlanks(call: SalesCall, p: MarketingCallEventPayload): Promise<void> {
    const patch: { marketingUserId?: string; ringingAt?: Date } = {};
    if (call.marketingUserId == null && p.internalNum) {
      const resolved = await this.resolveMarketingUserByDahili(call.workspaceId, p.internalNum);
      if (resolved) patch.marketingUserId = resolved;
    }
    if (call.ringingAt == null) patch.ringingAt = new Date();
    if (Object.keys(patch).length > 0) {
      await this.prisma.salesCall.update({ where: { id: call.id }, data: patch });
    }
  }

  // ---------------------------------------------------------------------
  // answer — best-effort CONNECTED bump + answeredByUserId; never creates a
  // row (unlike inbound_call/hangup/cdr, a bare 'answer' with nothing to
  // correlate to isn't actionable — the eventual hangup/cdr upserts if the
  // row is still missing).
  // ---------------------------------------------------------------------

  private async handleAnswer(workspaceId: string, p: MarketingCallEventPayload): Promise<void> {
    const call = await this.correlate(workspaceId, p);
    if (!call) return;

    const answeredBy = await this.resolveMarketingUserByDahili(workspaceId, p.internalNum);
    const claim = await this.prisma.salesCall.updateMany({
      where: { id: call.id, workspaceId, status: { in: NON_TERMINAL_STATUSES } },
      data: {
        status: 'CONNECTED',
        answeredByUserId: answeredBy ?? call.answeredByUserId ?? null,
        externalCallId: call.externalCallId ?? p.uniqueId ?? null,
      },
    });
    if (claim.count === 0) {
      this.logger.log(`telephony answer event: call ${call.id} already terminal (${call.status}) — no-op`);
    }
  }

  // ---------------------------------------------------------------------
  // hangup / cdr — terminal stamping for an OUTBOUND call, or upsert+stamp
  // for an INBOUND one (see class docstring for the full correlation order).
  // ---------------------------------------------------------------------

  private async handleTerminal(workspaceId: string, p: MarketingCallEventPayload): Promise<void> {
    const status = this.terminalStatusFor(p);
    let call = await this.correlate(workspaceId, p);

    if (!call && this.isInbound(p)) {
      // Out-of-order: hangup/cdr arrived before inbound_call (or
      // inbound_call never arrives) — upsert rather than drop the event.
      await this.createInboundCall(workspaceId, p, status);
      return;
    }
    if (!call) {
      this.logger.warn(
        `telephony ${p.kind} event: no SalesCall correlates (crmId=${p.crmId ?? 'null'} uniqueId=${p.uniqueId ?? 'null'} customerNum=${p.customerNum ?? 'null'}) — skipping`,
      );
      return;
    }

    await this.finalizeCall(workspaceId, call, p, status);
  }

  /** crmId (our own SalesCall.id) FIRST, then uniqueId -> externalCallId, then
   *  a last-10-digit match against still-INITIATED OUTBOUND calls (the
   *  presumed-outbound fallback — never used for an inbound-signaled event,
   *  see `isInbound`). */
  private async correlate(workspaceId: string, p: MarketingCallEventPayload): Promise<SalesCall | null> {
    if (p.crmId) {
      const byCrmId = await this.prisma.salesCall.findFirst({ where: { id: p.crmId, workspaceId } });
      if (byCrmId) return byCrmId;
    }
    if (p.uniqueId) {
      const byExternalId = await this.prisma.salesCall.findFirst({
        where: { workspaceId, externalCallId: p.uniqueId },
      });
      if (byExternalId) return byExternalId;
    }
    if (p.customerNum && !this.isInbound(p)) {
      const since = new Date(Date.now() - TelephonyEventConsumer.CORRELATION_WINDOW_HOURS * 3_600_000);
      const target = last10(p.customerNum);
      const candidates = await this.prisma.salesCall.findMany({
        where: { workspaceId, direction: 'OUTBOUND', status: 'INITIATED', startedAt: { gte: since } },
        orderBy: { startedAt: 'asc' },
      });
      const match = candidates.find((c) => last10(c.toPhone) === target);
      if (match) return match;
    }
    return null;
  }

  /** Atomic monotonic claim: only the FIRST hangup/cdr to reach a still-open
   *  call flips it terminal. A redelivered event, a race between two events
   *  for the same call, or a call the CDR poll already finalized all
   *  collapse to a no-op (claim.count === 0). */
  private async finalizeCall(
    workspaceId: string,
    call: SalesCall,
    p: MarketingCallEventPayload,
    status: string,
  ): Promise<void> {
    const claim = await this.prisma.salesCall.updateMany({
      where: { id: call.id, workspaceId, status: { in: NON_TERMINAL_STATUSES } },
      data: {
        status,
        externalCallId: call.externalCallId ?? p.uniqueId ?? null,
        durationSec: p.durationSec ?? null,
        recordingUrl: p.recording ?? null,
        endedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      this.logger.log(`telephony ${p.kind} event: call ${call.id} already terminal (${call.status}) — no-op`);
      return;
    }

    if (call.direction === 'INBOUND' && status === 'NO_ANSWER') {
      await this.handleMissedCall(workspaceId, call, p);
    }
  }

  // ---------------------------------------------------------------------
  // INBOUND row creation (shared by handleInboundCall's create path and
  // handleTerminal's out-of-order upsert path).
  // ---------------------------------------------------------------------

  private async createInboundCall(
    workspaceId: string,
    p: MarketingCallEventPayload,
    initialStatus: string,
  ): Promise<void> {
    const marketingUserId = await this.resolveMarketingUserByDahili(workspaceId, p.internalNum);
    const lead = await this.findLeadByPhone(workspaceId, p.customerNum);
    const now = new Date();
    const terminal = this.isTerminal(initialStatus);

    const call = await this.prisma.salesCall.create({
      data: {
        workspaceId,
        marketingUserId,
        leadId: lead?.id ?? null,
        direction: 'INBOUND',
        toPhone: p.customerNum ?? '',
        providerId: 'netgsm-netsantral',
        status: initialStatus,
        externalCallId: p.uniqueId,
        ringingAt: now,
        durationSec: terminal ? (p.durationSec ?? null) : null,
        recordingUrl: terminal ? (p.recording ?? null) : null,
        endedAt: terminal ? now : null,
      },
    });

    if (lead) {
      await this.mirrorLeadActivity(workspaceId, lead.id, marketingUserId, `Inbound call: ${initialStatus}`, initialStatus);
    }

    if (terminal && initialStatus === 'NO_ANSWER') {
      await this.handleMissedCall(workspaceId, call, p);
    }
  }

  // ---------------------------------------------------------------------
  // Missed call — follow-up task + marketing.call.missed.v1. Only ever
  // called from a path that just flipped INBOUND -> NO_ANSWER for the FIRST
  // time (finalizeCall's atomic claim / createInboundCall's fresh insert),
  // so this never double-fires for the same call.
  // ---------------------------------------------------------------------

  private async handleMissedCall(
    workspaceId: string,
    call: { id: string; leadId: string | null; marketingUserId: string | null },
    p: MarketingCallEventPayload,
  ): Promise<void> {
    // Assignee fallback chain mirrors WorkflowActionHandler.createTask: the
    // call's own rep (if the extension matched one), else the lead's owner,
    // else auto-assign. A missed call has no "actor" the way a manually
    // logged call does, so — unlike LeadActivity's sentinel fallback — there
    // is no sensible SYSTEM-user follow-up task; skip if nothing resolves.
    let assignee = call.marketingUserId;
    if (!assignee && call.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: call.leadId, workspaceId },
        select: { assignedToId: true },
      });
      assignee = lead?.assignedToId ?? null;
    }
    if (!assignee) {
      assignee = await this.autoAssigner.pickAssignee(workspaceId);
    }

    if (assignee) {
      await this.prisma.marketingTask.create({
        data: {
          workspaceId,
          title: `Missed call${p.customerNum ? ': ' + p.customerNum : ''}`,
          type: 'FOLLOW_UP',
          dueDate: new Date(Date.now() + 2 * 3600_000), // 2h — time-sensitive
          assignedToId: assignee,
          leadId: call.leadId,
        },
      });
    } else {
      this.logger.warn(`missed call ${call.id}: no assignee resolvable (no rep/auto-assign) — follow-up task skipped`);
    }

    await this.outbox.append({
      type: MarketingEventTypes.CallMissed,
      tenantId: null,
      idempotencyKey: `call-missed:${call.id}`,
      payload: {
        workspaceId,
        salesCallId: call.id,
        leadId: call.leadId,
        customerNum: p.customerNum,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Shared lookups
  // ---------------------------------------------------------------------

  /** null when unmatched — an inbound call to an unowned/unregistered
   *  extension still gets a SalesCall row, just with no rep attributed. */
  private async resolveMarketingUserByDahili(workspaceId: string, internalNum: string | null): Promise<string | null> {
    if (!internalNum) return null;
    const rep = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, dahili: internalNum, status: 'ACTIVE' },
      select: { id: true },
    });
    return rep?.id ?? null;
  }

  /** Canonical phone match — reuses the SAME util IysWebhookConsumer uses
   *  rather than forking a third copy (Phase 2 Task 4's LOW residual). */
  private async findLeadByPhone(
    workspaceId: string,
    customerNum: string | null,
  ): Promise<{ id: string; assignedToId: string | null } | null> {
    const normalized = normalizePhone(customerNum);
    if (!normalized) return null;
    const variants = localMsisdnVariants(normalized);
    return this.prisma.lead.findFirst({
      where: { workspaceId, phoneNormalized: { in: variants }, mergedIntoId: null, deletedAt: null },
      select: { id: true, assignedToId: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async mirrorLeadActivity(
    workspaceId: string,
    leadId: string,
    marketingUserId: string | null,
    title: string,
    status: string,
  ): Promise<void> {
    const actorId = marketingUserId ?? (await this.resolveSentinel(workspaceId));
    if (!actorId) {
      this.logger.warn(
        `telephony: no actor (rep or SYSTEM sentinel) to attribute lead activity for workspace=${workspaceId} — skipping timeline mirror`,
      );
      return;
    }
    await this.prisma.leadActivity.create({
      data: {
        type: 'CALL',
        title,
        outcome: this.outcomeFor(status),
        leadId,
        createdById: actorId,
      },
    });
  }

  /** Same idiom as ConversationIngressService/FormsService.resolveSentinel. */
  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    if (this.sentinelCache.has(workspaceId)) return this.sentinelCache.get(workspaceId)!;
    const row = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, role: 'SYSTEM' },
      select: { id: true },
    });
    const id = row?.id ?? null;
    this.sentinelCache.set(workspaceId, id);
    return id;
  }

  /** Task 1 MEDIUM follow-up: trust kind==='inbound_call' as an independent,
   *  scenario-level signal — never rely on `direction` alone (see class
   *  docstring's HARDENED INBOUND DETECTION section). */
  private isInbound(p: MarketingCallEventPayload): boolean {
    return p.kind === 'inbound_call' || p.direction === 'INBOUND';
  }

  private isTerminal(status: string): boolean {
    return !NON_TERMINAL_STATUSES.includes(status);
  }

  /** CONNECTED when actually answered (positive duration, or an explicit
   *  "answer/success/connect"-ish status token); otherwise BUSY/FAILED from
   *  the status token, defaulting to NO_ANSWER (a hangup with no duration and
   *  an unrecognized/absent status is the common "rang out" shape). */
  private terminalStatusFor(p: MarketingCallEventPayload): string {
    if (p.durationSec != null && p.durationSec > 0) return 'CONNECTED';
    const s = (p.status ?? '').toLowerCase();
    if (/no.?answer/.test(s)) return 'NO_ANSWER';
    if (s.includes('busy')) return 'BUSY';
    if (s.includes('fail') || s.includes('cancel') || s.includes('congestion') || s.includes('reject')) return 'FAILED';
    if (s.includes('answer') || s.includes('success') || s.includes('ok') || s.includes('connect')) return 'CONNECTED';
    return 'NO_ANSWER';
  }

  private outcomeFor(status: string): string {
    switch (status) {
      case 'CONNECTED':
        return 'POSITIVE';
      case 'NO_ANSWER':
        return 'NO_ANSWER';
      case 'BUSY':
      case 'FAILED':
        return 'NEGATIVE';
      default:
        return 'NEUTRAL';
    }
  }

  private remember(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > TelephonyEventConsumer.MAX_SEEN_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}

/** Last 10 digits of a phone number (TR numbers normalize cleanly this way) —
 *  mirrors CallCdrSyncService's own private `last10` (that file's is
 *  unexported, so this is a deliberate small duplication rather than a new
 *  cross-file coupling; keep in sync if either changes). */
function last10(phone?: string | null): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}
