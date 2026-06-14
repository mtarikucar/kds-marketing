import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../prisma/prisma.service';
import { withAdvisoryLock } from '../../common/scheduling/advisory-lock';
import { RoutineConfigService } from './routine-config.service';
import { RoutineTriggerService } from './routine-trigger.service';

/**
 * Manages dynamic CronJobs for routine triggers.
 *
 * On boot, `reloadAll()` scans all configs and registers a CronJob
 * for each enabled config with a non-null cron string.
 *
 * `reload(key)` is called after every config update (by RoutineConfigService)
 * so the scheduler stays in sync with the DB without a restart.
 *
 * Each cron tick is wrapped in `withAdvisoryLock` so only one replica fires
 * the trigger in a multi-replica deploy.
 */
@Injectable()
export class RoutineScheduleRunner implements OnModuleInit {
  private readonly logger = new Logger(RoutineScheduleRunner.name);

  constructor(
    private readonly routineConfigService: RoutineConfigService,
    private readonly routineTriggerService: RoutineTriggerService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadAll();
  }

  /**
   * Register CronJobs for all enabled configs that have a cron.
   * Called once on boot.
   */
  async reloadAll(): Promise<void> {
    const configs = await this.routineConfigService.list();
    for (const config of configs) {
      if (config.enabled && config.cron) {
        this.registerJob(config.key, config.cron);
      }
    }
  }

  /**
   * Re-sync the CronJob for a single key after a config update.
   * Removes the existing job (if any) and re-adds if enabled+cron.
   */
  async reload(key: string): Promise<void> {
    const jobName = `routine:${key}`;

    // Remove existing job if present
    if (this.schedulerRegistry.doesExist('cron', jobName)) {
      try {
        this.schedulerRegistry.deleteCronJob(jobName);
        this.logger.debug(`Removed existing cron job: ${jobName}`);
      } catch (err) {
        this.logger.warn(`Failed to delete cron job ${jobName}: ${(err as Error).message}`);
      }
    }

    // Re-add if config warrants it
    const config = await this.routineConfigService.get(key);
    if (!config || !config.enabled || !config.cron) {
      return;
    }

    this.registerJob(key, config.cron);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private registerJob(key: string, cron: string): void {
    const jobName = `routine:${key}`;
    const lockName = `routine-sched:${key}`;

    let job: CronJob;
    try {
      job = new CronJob(cron, () => {
        // Fire inside advisory lock — multi-replica safe
        void withAdvisoryLock(
          this.prisma,
          lockName,
          () => this.routineTriggerService.trigger(key, 'schedule').then(() => undefined),
          this.logger,
        );
      });
    } catch (err) {
      this.logger.error(
        `Invalid cron expression for routine ${key} (${cron}): ${(err as Error).message}`,
      );
      return;
    }

    this.schedulerRegistry.addCronJob(jobName, job);
    job.start();
    this.logger.log(`Registered cron job ${jobName} with expression: ${cron}`);
  }
}
