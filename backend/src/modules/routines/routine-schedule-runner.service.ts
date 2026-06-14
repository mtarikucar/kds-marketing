import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../prisma/prisma.service';
import { withAdvisoryXactLock } from '../../common/scheduling/advisory-lock';
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
 * Each cron tick is wrapped in `withAdvisoryXactLock` so only one replica fires
 * the trigger in a multi-replica deploy (connection-safe: lock tied to one
 * connection, auto-released at transaction commit/rollback).
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
        // Fire inside advisory xact lock — connection-safe, multi-replica safe.
        // Attach .catch() so a rejected promise never becomes an unhandled rejection.
        void withAdvisoryXactLock(
          this.prisma,
          lockName,
          () => this.routineTriggerService.trigger(key, 'schedule').then(() => undefined),
          { logger: this.logger },
        ).catch((err: Error) =>
          this.logger.error(`routine ${key} schedule tick failed: ${err.message}`),
        );
      });
    } catch (err) {
      this.logger.error(
        `Invalid cron expression for routine ${key} (${cron}): ${(err as Error).message}`,
      );
      return;
    }

    try {
      this.schedulerRegistry.addCronJob(jobName, job);
      job.start();
    } catch (err) {
      this.logger.error(
        `Failed to register cron job ${jobName}: ${(err as Error).message}`,
      );
      return;
    }
    this.logger.log(`Registered cron job ${jobName} with expression: ${cron}`);
  }
}
