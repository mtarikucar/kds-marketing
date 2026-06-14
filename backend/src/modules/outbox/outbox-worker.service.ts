import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DomainEventBus } from "./domain-event-bus.service";

/**
 * Drains queued OutboxEvent rows onto the in-process DomainEventBus.
 *
 * Single-process implementation: a poll loop wakes every BASE_POLL_MS,
 * claims a batch of rows by flipping status='queued' → 'dispatching' inside
 * a transaction (with row-level locking via Postgres FOR UPDATE SKIP LOCKED
 * so multiple replicas would coordinate safely once we scale out), then
 * dispatches each onto the bus and flips to 'dispatched'. Failed dispatches
 * bump `attempts` with exponential backoff and surface in `lastError`.
 *
 * The polling is intentional rather than triggered by NOTIFY: it's robust
 * under crashes and replica restarts, has bounded recovery time, and trivial
 * to reason about. NOTIFY-driven fast path can be layered on later.
 */
@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly BASE_POLL_MS = 500;
  private readonly BATCH = 50;
  private readonly MAX_ATTEMPTS = 8;
  // Retention: how long dispatched (success) rows stay around before the
  // pruner deletes them. Configurable via env so ops can extend the
  // forensic window without a deploy. Failed rows are NEVER auto-pruned
  // — they're the DLQ; operator must triage manually.
  private readonly RETENTION_DAYS = Number(
    process.env.OUTBOX_RETENTION_DAYS ?? "14",
  );
  private readonly PRUNE_INTERVAL_MS = 60 * 60_000; // every hour
  // Cap deletions per batch so a backlog doesn't lock the table.
  private readonly PRUNE_BATCH = 5_000;
  // Reclaim window: a row stuck in 'dispatching' longer than this was almost
  // certainly orphaned by a crash/restart between the claim flip and the
  // terminal update (the in-process bus has no durable ack). The sweep flips
  // it back to 'queued' so the next drain retries it. Configurable via env.
  private readonly RECLAIM_AFTER_MS = Number(
    process.env.OUTBOX_RECLAIM_AFTER_MS ?? String(5 * 60_000),
  );

  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private running = false;
  private pruning = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    // v2.8.97 — warn at boot if retention is too short. The webhook
    // delivery worker uses exponential backoff capped at 6h between
    // retries; retention below the worst-case retry envelope risks
    // pruning a row whose downstream delivery is still legitimately
    // queued. Recommended floor: 7 days (matches the per-row max
    // attempts × backoff cap). Warn but don't refuse to boot so a
    // deliberately-aggressive prune (e.g. cost-pressed staging) is
    // still possible.
    if (this.RETENTION_DAYS < 7 && this.RETENTION_DAYS >= 1) {
      this.logger.warn(
        `OUTBOX_RETENTION_DAYS=${this.RETENTION_DAYS} is below the recommended 7-day floor. ` +
          `Webhook delivery backoff caps at 6h between retries; rows pruned before delivery completes are silently lost. ` +
          `Raise the env to 7+ unless you've manually verified the delivery worker drains the outbox faster than your retention window.`,
      );
    }
    this.scheduleNext(0);
    // First prune fires shortly after boot so a stale ops dashboard
    // shows a fresh count immediately; subsequent runs are hourly.
    this.schedulePrune(60_000);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => this.tick().catch(() => undefined), delayMs);
  }

  private schedulePrune(delayMs: number): void {
    if (this.stopping) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneOnce()
        .catch((e) =>
          this.logger.warn(`outbox prune failed: ${(e as Error).message}`),
        )
        .finally(() => this.schedulePrune(this.PRUNE_INTERVAL_MS));
    }, delayMs);
  }

  /**
   * Delete dispatched rows older than RETENTION_DAYS. Bounded batch keeps
   * the lock window short; if a backlog exists the next hourly run picks
   * up the rest. Failed rows are excluded by design — they're the DLQ
   * and need operator triage via the SuperadminOutboxController.
   */
  private async pruneOnce(): Promise<void> {
    if (this.pruning) return;
    if (this.RETENTION_DAYS < 1) return; // safety: never delete on bad config
    this.pruning = true;
    try {
      const cutoff = new Date(
        Date.now() - this.RETENTION_DAYS * 24 * 60 * 60_000,
      );
      const result = await this.prisma.$executeRaw`
        DELETE FROM "outbox_events"
         WHERE "id" IN (
           SELECT "id" FROM "outbox_events"
            WHERE "status" = 'dispatched'
              AND "dispatchedAt" IS NOT NULL
              AND "dispatchedAt" < ${cutoff}
            LIMIT ${this.PRUNE_BATCH}
         )
      `;
      if (result > 0) {
        this.logger.log(
          `outbox prune: removed ${result} dispatched rows older than ${this.RETENTION_DAYS}d`,
        );
      }
    } finally {
      this.pruning = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.scheduleNext(this.BASE_POLL_MS);
      return;
    }
    this.running = true;
    try {
      const drained = await this.drainOnce();
      // If we drained a full batch, immediately try again — backlog catch-up.
      // Otherwise sleep until the next poll cycle.
      this.scheduleNext(drained >= this.BATCH ? 0 : this.BASE_POLL_MS);
    } catch (e) {
      this.logger.error(`outbox tick failed: ${(e as Error).message}`);
      this.scheduleNext(this.BASE_POLL_MS);
    } finally {
      this.running = false;
    }
  }

  /**
   * Recover orphaned claims: rows left in 'dispatching' past RECLAIM_AFTER_MS
   * (the worker died between the claim flip and the terminal update) are
   * flipped back to 'queued' with an immediate nextAttemptAt so the next claim
   * picks them up. FOR UPDATE SKIP LOCKED keeps this safe under multiple
   * replicas. attempts is intentionally NOT bumped here — the failed dispatch
   * already incremented it (or never ran), and the per-attempt cap still
   * eventually DLQs a row that keeps orphaning.
   */
  private async reclaimStale(): Promise<number> {
    const cutoff = new Date(Date.now() - this.RECLAIM_AFTER_MS);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "outbox_events"
         SET "status" = 'queued', "nextAttemptAt" = ${new Date()}
       WHERE "id" IN (
         SELECT "id" FROM "outbox_events"
          WHERE "status" = 'dispatching'
            AND "claimedAt" IS NOT NULL
            AND "claimedAt" < ${cutoff}
          ORDER BY "id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.BATCH}
       )
       RETURNING "id";
    `;
    if (rows.length > 0) {
      this.logger.warn(
        `outbox reclaim: requeued ${rows.length} row(s) stuck in 'dispatching' older than ${this.RECLAIM_AFTER_MS}ms (orphaned by a crash/restart)`,
      );
    }
    return rows.length;
  }

  private async drainOnce(): Promise<number> {
    // First, recover any claims orphaned by a prior crash so they re-enter the
    // queue before we claim a fresh batch below.
    await this.reclaimStale();
    // Claim a batch atomically. Using raw SQL because Prisma can't express
    // FOR UPDATE SKIP LOCKED on the same statement that returns the rows.
    // Postgres syntax: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
    // LOCKED LIMIT N) RETURNING *.
    const now = new Date();
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        tenantId: string | null;
        payload: any;
        idempotencyKey: string;
        attempts: number;
        createdAt: Date;
      }>
    >`
      UPDATE "outbox_events"
         SET "status" = 'dispatching', "attempts" = "attempts" + 1, "claimedAt" = ${now}
       WHERE "id" IN (
         SELECT "id" FROM "outbox_events"
          WHERE "status" = 'queued'
            AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
          ORDER BY "id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.BATCH}
       )
       RETURNING "id", "type", "tenantId", "payload", "idempotencyKey", "attempts", "createdAt";
    `;

    for (const r of rows) {
      try {
        await this.bus.dispatch({
          id: r.id,
          type: r.type,
          tenantId: r.tenantId,
          payload: r.payload,
          idempotencyKey: r.idempotencyKey,
          createdAt: r.createdAt,
        });
        // Guard the terminal flip on status='dispatching': if the reclaim
        // sweep already requeued this row (we ran long past RECLAIM_AFTER_MS),
        // its status is back to 'queued' and we must NOT overwrite that with
        // 'dispatched' — updateMany with the guard makes the late writer a
        // no-op instead of resurrecting a row another worker now owns.
        await this.prisma.outboxEvent.updateMany({
          where: { id: r.id, status: "dispatching" },
          data: {
            status: "dispatched",
            dispatchedAt: new Date(),
            lastError: null,
          },
        });
      } catch (e) {
        const msg = (e as Error).message?.slice(0, 500) ?? "unknown";
        const final = r.attempts >= this.MAX_ATTEMPTS;
        // Backoff: 0.5s, 1s, 2s, 4s, ... capped at 5min.
        const backoffMs = Math.min(500 * 2 ** r.attempts, 5 * 60_000);
        // Same dispatching-guard as the success path: only the worker that
        // still owns the claim writes the failure/requeue outcome. If the
        // reclaim sweep beat us here the row is already 'queued' again.
        await this.prisma.outboxEvent.updateMany({
          where: { id: r.id, status: "dispatching" },
          data: {
            status: final ? "failed" : "queued",
            lastError: msg,
            nextAttemptAt: final ? null : new Date(Date.now() + backoffMs),
          },
        });
        if (final) {
          // DLQ wording is intentional: ops alert rules grep on
          // "outbox DLQ" to wake someone up. Once an event lands here
          // it will not be retried automatically — operator must
          // requeue via SuperadminOutboxController or delete it.
          this.logger.error(
            `outbox DLQ: event ${r.id} (${r.type}) gave up after ${r.attempts} attempts — ${msg}`,
          );
        } else {
          this.logger.warn(
            `outbox event ${r.id} (${r.type}) will retry after ${r.attempts} attempts: ${msg}`,
          );
        }
      }
    }
    return rows.length;
  }
}
