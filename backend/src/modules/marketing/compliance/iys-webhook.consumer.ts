import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingIysConsentPayload } from '../events/marketing-event-types';
import { localMsisdnVariants, normalizePhone } from '../utils/lead-normalize';
import { ComplianceService } from './compliance.service';

/**
 * İYS push-back apply (NetGSM Phase 2 Task 4). Subscribes
 * `marketing.iys.consent.v1` (published by NetgsmEventsController's `iys`
 * route once per NEW array element it archives) and applies the ONAY/RET
 * İYS reports back onto the matching lead's MARKETING_SMS consent.
 *
 * ANTI-FEEDBACK-LOOP — READ BEFORE TOUCHING THIS FILE: `recordConsent`'s
 * MARKETING_SMS branch (`ComplianceService.emitSmsOptEvent`) ALSO enqueues an
 * `IysSyncJob` to push the change BACK to İYS (Phase 2 Task 3's auto-push).
 * Applying an İYS-ORIGINATED change through that same path would re-submit it
 * to İYS — a feedback loop. The `source: 'IYS_' + …` prefix passed below is
 * not just an audit tag: `IysSyncService.enqueueConsent` explicitly skips
 * enqueueing whenever `source` starts with `IYS_` (its own guard) — that is
 * the ONLY thing preventing the loop, so it must never be removed, bypassed,
 * or have its prefix changed without updating that guard too.
 *
 * Idempotency, two layers:
 *  - `DomainEvent.id` dedupe (bounded in-memory Set, same idiom as
 *    `NetgsmBlacklistSyncService`) guards against the outbox worker's
 *    orphan-reclaim sweep re-dispatching the same row.
 *  - A second, STATE-level guard compares the lead's latest MARKETING_SMS
 *    `ConsentRecord` to the incoming status BEFORE writing anything — İYS
 *    can (and does) redeliver the same consent change across ticks/webhook
 *    retries, and without this a resend would create a duplicate
 *    ConsentRecord even after the event.id dedupe above has been cleared
 *    (e.g. by a process restart, which empties the in-memory Set).
 *
 * Only MESAJ (SMS) is applied this phase — ARAMA (call consent) lands with
 * Phase 5 voice campaigns, EPOSTA (email) is out of scope for this program;
 * both are logged and skipped rather than silently dropped. An unresolved
 * recipient (no lead matches the normalized phone in that workspace) is
 * likewise logged and skipped — İYS may hold consent rows for numbers this
 * CRM has never seen.
 *
 * PHONE MATCH: İYS's `recipient` arrives as `90XXXXXXXXXX` (no `+`), but this
 * app's lead-creation paths do NOT reconcile that against 0-prefixed /
 * bare-10-digit input before writing `phoneNormalized` (`normalizePhone` is a
 * pure digit-strip). The lead lookup below therefore matches against every
 * spelling `localMsisdnVariants` enumerates, not just the one İYS sent — an
 * exact-match-only lookup here previously meant a real İYS opt-out could
 * silently no-op as "unknown phone" against a lead stored under a different
 * digit shape.
 *
 * FAIL-CLOSED ON STATUS: `status` is only ever 'ONAY' or 'RET' by contract
 * (NetgsmEventsController.iys never publishes anything else), but this
 * handler re-checks it anyway before treating it as a grant/revoke — an
 * unrecognized value is skipped, never defaulted to granted=false or true.
 */
@Injectable()
export class IysWebhookConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IysWebhookConsumer.name);

  /** Bounded dedup cache; oldest entries evicted once the cap is hit — mirrors
   *  NetgsmBlacklistSyncService's seenEventIds cap/rationale. */
  private static readonly MAX_SEEN_IDS = 2_000;
  private readonly seenEventIds = new Set<string>();

  // v3.0.1 round-4 audit fix idiom (see SettlementCommissionConsumer) — a
  // stable handler ref so onModuleDestroy can detach it; an inline closure
  // registered once but never removed leaks across HMR/test teardown.
  private readonly consentHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingIysConsentPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly compliance: ComplianceService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.IysConsentReceived, this.consentHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.IysConsentReceived, this.consentHandler);
  }

  private async handle(event: DomainEvent<MarketingIysConsentPayload>): Promise<void> {
    if (this.seenEventIds.has(event.id)) return; // already processed (replay)
    this.remember(event.id);

    const { workspaceId, recipient, type, status, source } =
      event.payload ?? ({} as MarketingIysConsentPayload);
    if (!workspaceId) {
      this.logger.warn(`iys webhook consent: event ${event.id} missing workspaceId — skipping`);
      return;
    }
    if (type !== 'MESAJ') {
      // ARAMA / EPOSTA — deliberate YAGNI deferral (see class docstring), not
      // an oversight. Logged so the deferral stays visible operationally.
      this.logger.log(`iys webhook consent: event ${event.id} type=${type} not applied this phase — skipping`);
      return;
    }

    // Defense in depth: NetgsmEventsController.iys only ever forwards an
    // exactly-'ONAY'/exactly-'RET' status (anything else is archived, never
    // published — see that controller's docstring), but `status` arrives
    // here as an untyped event payload, not a compiler-enforced union. A
    // value that is somehow neither must be skipped, NOT defaulted to
    // granted=false (that would silently write a bogus opt-out
    // ConsentRecord for a signal that was never actually a RET).
    if (status !== 'ONAY' && status !== 'RET') {
      this.logger.warn(`iys webhook consent: event ${event.id} has unrecognized status '${status}' — skipping`);
      return;
    }

    const phoneNormalized = normalizePhone(recipient);
    if (!phoneNormalized) {
      this.logger.warn(`iys webhook consent: event ${event.id} has no usable recipient phone — skipping`);
      return;
    }

    // Reconcile İYS's recipient shape (90XXXXXXXXXX, no +) against however
    // THIS app's lead-creation paths happened to populate phoneNormalized
    // (0-prefixed, bare-10-digit, or 90-prefixed — see localMsisdnVariants'
    // docstring) — an exact-match lookup on one shape alone silently misses
    // leads written via a different path, which is exactly how a real İYS
    // opt-out previously went unapplied.
    const phoneVariants = localMsisdnVariants(phoneNormalized);

    const lead = await this.prisma.lead.findFirst({
      where: { workspaceId, phoneNormalized: { in: phoneVariants }, mergedIntoId: null, deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!lead) {
      this.logger.warn(
        `iys webhook consent: no lead found for workspace=${workspaceId} phone=${phoneNormalized} — skipping`,
      );
      return;
    }

    const granted = status === 'ONAY';

    // IDEMPOTENCY GUARD: a resend of the exact same consent state must never
    // write a duplicate ConsentRecord (and, absent the IYS_ source-prefix
    // guard in IysSyncService, would even re-enqueue a pointless İYS push).
    const latest = await this.prisma.consentRecord.findFirst({
      where: { workspaceId, leadId: lead.id, type: 'MARKETING_SMS' },
      orderBy: { createdAt: 'desc' },
      select: { granted: true },
    });
    if (latest && latest.granted === granted) {
      return;
    }

    await this.compliance.recordConsent(workspaceId, lead.id, 'MARKETING_SMS', granted, {
      source: `IYS_${source || 'UNKNOWN'}`,
    });
  }

  private remember(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > IysWebhookConsumer.MAX_SEEN_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}
