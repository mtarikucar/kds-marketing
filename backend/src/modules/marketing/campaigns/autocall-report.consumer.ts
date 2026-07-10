import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingAutocallReportPayload } from '../events/marketing-event-types';
import { normalizePhone, localMsisdnVariants } from '../utils/lead-normalize';

/**
 * Auto-dialer per-attempt report consumer (NetGSM Phase 5 Task 5). Subscribes
 * `marketing.autocall.report.v1` (published by NetgsmEventsController's
 * `autocall-report` route from a NEW (JobID, unique_id) element it archived)
 * and:
 *
 *  - correlates by `jobId` == `AutocallSession.netgsmListId` (workspace-
 *    scoped, ANY session status — a trailing report can arrive after `stop()`
 *    already flipped the session STOPPED, and it's still worth recording).
 *    An unknown jobId is skipped + logged — never guessed at.
 *
 *  - within that session, matches `called` to ONE `AutocallSessionItem` by
 *    phone. NetGSM may echo the number in a different spelling than we sent
 *    it in (0-prefixed vs 90-prefixed vs bare-10-digit) — `normalizePhone` +
 *    `localMsisdnVariants` reconcile every known Turkish-mobile spelling
 *    (same reasoning `lead-normalize.ts`'s own docstring lays out for any
 *    externally-sourced MSISDN). A session has at most 100 items, so this is
 *    a small in-memory scan, not a query concern. An unmatched `called` is
 *    skipped + logged (never guessed at — this consumer never falls back to
 *    "the only PENDING item" or similar).
 *
 *  - writes `lastAttemptStatus`/`lastUniqueId`/`attemptedAt` — ALWAYS the
 *    MOST RECENT attempt only (no history table). NetGSM's autocall status
 *    vocabulary is NOT researched (unlike voice-report's durum 1/2/3/7), so
 *    the raw string is kept verbatim rather than mapped to a canonical
 *    enum — a future task can add that mapping once a real account confirms
 *    the wire values, without touching this consumer's correlation logic.
 *
 * IDEMPOTENCY: `DomainEvent.id` dedupe (bounded in-memory Set — same idiom as
 * VoiceReportConsumer/TelephonyEventConsumer/IysWebhookConsumer) guards the
 * outbox worker's orphan-reclaim sweep re-dispatching the same row. The
 * controller's own per-(JobID, unique_id) archive dedupe means a genuinely
 * NEW event reaching this consumer is always a distinct attempt.
 */
@Injectable()
export class AutocallReportConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutocallReportConsumer.name);

  private static readonly MAX_SEEN_IDS = 2_000;
  private readonly seenEventIds = new Set<string>();

  private readonly reportHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingAutocallReportPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.AutocallReport, this.reportHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.AutocallReport, this.reportHandler);
  }

  private async handle(event: DomainEvent<MarketingAutocallReportPayload>): Promise<void> {
    if (this.seenEventIds.has(event.id)) return; // already processed (replay)
    this.remember(event.id);

    const p = event.payload ?? ({} as MarketingAutocallReportPayload);
    if (!p.workspaceId || !p.jobId) {
      this.logger.warn(`autocall report event ${event.id} missing workspaceId/jobId — skipping`);
      return;
    }

    const session = await this.prisma.autocallSession.findFirst({
      where: { workspaceId: p.workspaceId, netgsmListId: p.jobId },
      select: { id: true },
    });
    if (!session) {
      this.logger.warn(
        `autocall report event ${event.id}: no AutocallSession for jobId=${p.jobId} workspace=${p.workspaceId} — unknown jobId, skipping`,
      );
      return;
    }

    if (!p.called) {
      this.logger.warn(`autocall report event ${event.id}: no \`called\` number to correlate — skipping`);
      return;
    }
    const items = await this.prisma.autocallSessionItem.findMany({
      where: { autocallSessionId: session.id, workspaceId: p.workspaceId },
      select: { id: true, phone: true },
    });
    const item = this.matchByPhone(items, p.called);
    if (!item) {
      this.logger.warn(
        `autocall report event ${event.id}: called=${p.called} matched no item in session ${session.id} — skipping`,
      );
      return;
    }

    await this.prisma.autocallSessionItem.update({
      where: { id: item.id },
      data: { lastAttemptStatus: p.status ?? null, lastUniqueId: p.uniqueId ?? null, attemptedAt: new Date() },
    });
  }

  /** Reconciles every known Turkish-mobile spelling (see class docstring) —
   *  never a partial/loose match, only an exact normalized-variant hit. */
  private matchByPhone(items: Array<{ id: string; phone: string }>, called: string): { id: string; phone: string } | undefined {
    const calledNorm = normalizePhone(called);
    if (!calledNorm) return undefined;
    const calledVariants = new Set(localMsisdnVariants(calledNorm));
    return items.find((it) => {
      const itNorm = normalizePhone(it.phone);
      if (!itNorm) return false;
      if (itNorm === calledNorm) return true;
      return localMsisdnVariants(itNorm).some((v) => calledVariants.has(v));
    });
  }

  private remember(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > AutocallReportConsumer.MAX_SEEN_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}
