import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';
import { withAdvisoryLock } from '../../common/scheduling/advisory-lock';

/** Days an unpaid ACTIVE subscription keeps its entitlements. */
const PAST_DUE_GRACE_DAYS = 7;

/**
 * Billing lifecycle crons. Read-side belts exist in EntitlementsService
 * (an expired trial computes to zero immediately) — these flips make the
 * states durable and visible in the panel/console.
 */
@Injectable()
export class BillingSchedulerService {
  private readonly logger = new Logger(BillingSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweepLifecycle(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'billing:lifecycle-sweep',
      async () => {
        const now = new Date();

        // 1) Trials past their end.
        const expiredTrials = await this.prisma.workspaceSubscription.findMany({
          where: { status: 'TRIALING', trialEndsAt: { lt: now } },
          select: { id: true, workspaceId: true },
        });
        for (const sub of expiredTrials) {
          await this.prisma.workspaceSubscription.update({
            where: { id: sub.id },
            data: { status: 'EXPIRED' },
          });
          this.entitlements.invalidate(sub.workspaceId);
        }

        // 2) Paid periods that lapsed → PAST_DUE (entitlements keep working
        //    through the grace window).
        const lapsed = await this.prisma.workspaceSubscription.findMany({
          where: { status: 'ACTIVE', currentPeriodEnd: { lt: now } },
          select: { id: true, workspaceId: true, cancelAtPeriodEnd: true },
        });
        for (const sub of lapsed) {
          await this.prisma.workspaceSubscription.update({
            where: { id: sub.id },
            data: { status: sub.cancelAtPeriodEnd ? 'CANCELLED' : 'PAST_DUE' },
          });
          this.entitlements.invalidate(sub.workspaceId);
        }

        // 3) PAST_DUE past the grace window → EXPIRED (quota hits zero).
        const graceCutoff = new Date(
          now.getTime() - PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000,
        );
        const dead = await this.prisma.workspaceSubscription.findMany({
          where: { status: 'PAST_DUE', currentPeriodEnd: { lt: graceCutoff } },
          select: { id: true, workspaceId: true },
        });
        for (const sub of dead) {
          await this.prisma.workspaceSubscription.update({
            where: { id: sub.id },
            data: { status: 'EXPIRED' },
          });
          this.entitlements.invalidate(sub.workspaceId);
        }

        // 4) Add-on boosts that rode a period now behind us.
        await this.prisma.workspaceAddOn.updateMany({
          where: { status: 'ACTIVE', currentPeriodEnd: { lt: now } },
          data: { status: 'EXPIRED' },
        });

        if (expiredTrials.length || lapsed.length || dead.length) {
          this.logger.log(
            `lifecycle sweep: trials→expired=${expiredTrials.length} active→past_due/cancelled=${lapsed.length} past_due→expired=${dead.length}`,
          );
        }
      },
      this.logger,
    );
  }
}
