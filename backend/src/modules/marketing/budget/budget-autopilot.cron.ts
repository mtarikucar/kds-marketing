import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { BudgetPacerService } from './budget-pacer.service';
import { BudgetAutopilotService } from './budget-autopilot.service';
import { PerformanceLoopService } from './performance-loop.service';

/**
 * Hourly Budget Autopilot tick. For every ACTIVE, non-killed growth budget it
 * runs the PID pacer and records a SHADOW allocation proposal — so the autopilot
 * is genuinely "live" in observation mode without ever moving money (autonomy +
 * approval gating ship in a later slice). Single-replica via advisory lock;
 * self-gating (no budgets → no work), so it stays inert until a workspace opts
 * in by creating a growth budget.
 */
@Injectable()
export class BudgetAutopilotCron {
  private readonly logger = new Logger(BudgetAutopilotCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pacer: BudgetPacerService,
    private readonly autopilot: BudgetAutopilotService,
    private readonly performanceLoop: PerformanceLoopService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'budget-autopilot-tick' })
  async tick(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'budget:autopilot-tick',
      async () => {
        await this.runAll();
      },
      this.logger,
    );
  }

  /** Pace + shadow-propose every active budget. Isolated for testability. */
  async runAll(now: Date = new Date()): Promise<number> {
    const budgets = await this.prisma.growthBudget.findMany({
      where: { status: 'ACTIVE', killSwitch: false },
      select: { id: true, workspaceId: true },
      take: 500,
    });
    // Refresh first-party revenue onto AdMetric once per workspace BEFORE
    // proposing, so the allocator optimizes on CRM revenue not platform ROAS.
    for (const workspaceId of new Set(budgets.map((b) => b.workspaceId))) {
      try {
        await this.performanceLoop.reconcile(workspaceId, undefined, now);
      } catch (e) {
        this.logger.error(`performance-loop reconcile failed for ${workspaceId}: ${(e as Error)?.message ?? e}`);
      }
    }

    let ticked = 0;
    for (const b of budgets) {
      try {
        await this.pacer.tick(b.workspaceId, b.id, now);
        await this.autopilot.propose(b.workspaceId, b.id, now);
        ticked++;
      } catch (e) {
        this.logger.error(`autopilot tick failed for budget ${b.id}: ${(e as Error)?.message ?? e}`);
      }
    }
    if (ticked > 0) this.logger.log(`budget-autopilot: ticked ${ticked}/${budgets.length} active budget(s)`);
    return ticked;
  }
}
