import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Hourly recurring-invoice sweep for CustomerSubscriptions. Copies
 * BillingSchedulerService exactly: a single-replica advisory lock guards the
 * tick so two replicas never both sweep. The DUE-ROW query here is the one
 * legitimately cross-workspace read (a system job) — whitelisted in the
 * workspace-scoping fitness test; every write it triggers (in billOne) is
 * workspace-scoped or id-keyed. Per-row try/catch means one bad subscription
 * never blocks the others, and the (subscription, period) partial-unique index
 * makes a duplicate invoice impossible even on retry.
 */
@Injectable()
export class SubscriptionsSchedulerService {
  private readonly logger = new Logger(SubscriptionsSchedulerService.name);
  /** Bound work per tick; remaining due rows roll to the next hourly tick. */
  private static readonly BATCH = 500;
  /** Stop retrying a row after this many consecutive transient failures (~1 day
   *  at hourly cadence) so one poison-pill can't occupy a batch slot forever. */
  private static readonly MAX_FAILS = 24;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'subscriptions-generate-invoices' })
  async generateDueInvoices(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'subscriptions:generate-invoices',
      async () => {
        const now = new Date();
        // System-global read: due ACTIVE subscriptions across ALL workspaces.
        // A row that has failed MAX_FAILS times in a row is excluded (poison-pill
        // guard) — it stays ACTIVE+due but is no longer swept until an operator
        // fixes it (which resets failedAttempts via an edit) or it's cancelled.
        const due = await this.prisma.customerSubscription.findMany({
          where: {
            status: 'ACTIVE',
            nextBillingAt: { lte: now },
            failedAttempts: { lt: SubscriptionsSchedulerService.MAX_FAILS },
          },
          orderBy: { nextBillingAt: 'asc' },
          take: SubscriptionsSchedulerService.BATCH,
        });
        if (due.length === 0) return;

        let billed = 0;
        for (const sub of due) {
          try {
            const outcome = await this.subscriptions.billOne(sub, now);
            if (outcome === 'billed') billed++;
          } catch (e) {
            // One bad row never aborts the loop. billOne leaves nextBillingAt
            // untouched on a transient error, so bump failedAttempts here to
            // bound the retry (id-keyed update; the period stays due).
            this.logger.error(
              `subscription ${sub.id} sweep failed: ${(e as Error)?.message ?? e}`,
            );
            await this.prisma.customerSubscription
              .update({ where: { id: sub.id }, data: { failedAttempts: { increment: 1 } } })
              .catch(() => undefined);
          }
        }
        if (billed > 0) this.logger.log(`subscription sweep: generated ${billed} invoice(s)`);
      },
      this.logger,
    );
  }
}
