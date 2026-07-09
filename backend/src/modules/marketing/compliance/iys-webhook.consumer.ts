import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingIysConsentPayload } from '../events/marketing-event-types';
import { normalizePhone } from '../utils/lead-normalize';
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

    const phoneNormalized = normalizePhone(recipient);
    if (!phoneNormalized) {
      this.logger.warn(`iys webhook consent: event ${event.id} has no usable recipient phone — skipping`);
      return;
    }

    const lead = await this.prisma.lead.findFirst({
      where: { workspaceId, phoneNormalized, mergedIntoId: null, deletedAt: null },
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
