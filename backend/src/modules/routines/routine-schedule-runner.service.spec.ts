/**
 * RoutineScheduleRunner — plain-instantiation spec.
 *
 * Covers:
 *   - reloadAll() registers a CronJob for each enabled config with a cron
 *   - reloadAll() skips configs that are disabled
 *   - reloadAll() skips configs that have no cron
 *   - reload(key) registers a job for enabled+cron config
 *   - reload(key) removes job for disabled config
 *   - reload(key) removes job for config with no cron
 *   - reload(key) invalid cron is caught and logged (does not throw)
 *   - reload(key) deletes existing job before re-adding
 *   - addCronJob failure is caught and logged (does not throw)
 */

// ── mock withAdvisoryXactLock ────────────────────────────────────────────────
const mockWithAdvisoryXactLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../common/scheduling/advisory-lock', () => ({
  withAdvisoryXactLock: (...args: unknown[]) => mockWithAdvisoryXactLock(...args),
}));

import { RoutineScheduleRunner } from './routine-schedule-runner.service';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'id-1',
    key: 'review-draft',
    enabled: true,
    cron: '0 * * * *',
    onEvent: false,
    triggerUrl: 'https://claude.ai/api/trigger/abc',
    triggerTokenSealed: null,
    eventCooldownSec: 300,
    lastTriggeredAt: null,
    lastTriggerStatus: null,
    lastTriggerError: null,
    hasToken: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeConfigService(configs: ReturnType<typeof makeConfig>[] = [makeConfig()]) {
  return {
    list: jest.fn().mockResolvedValue(configs),
    get: jest.fn().mockImplementation((key: string) =>
      Promise.resolve(configs.find((c) => c.key === key) ?? null),
    ),
  };
}

function makeTriggerService() {
  return {
    trigger: jest.fn().mockResolvedValue({ ok: true }),
  };
}

function makeSchedulerRegistry() {
  const jobs = new Map<string, any>();
  const registry = {
    doesExist: jest.fn().mockImplementation((_type: string, name: string) => jobs.has(name)),
    addCronJob: jest.fn().mockImplementation((_name: string, job: any) => {
      jobs.set(_name, job);
    }),
    deleteCronJob: jest.fn().mockImplementation((name: string) => {
      const job = jobs.get(name);
      if (job && typeof job.stop === 'function') {
        job.stop();
      }
      jobs.delete(name);
    }),
    getCronJob: jest.fn().mockImplementation((name: string) => jobs.get(name)),
    _jobs: jobs,
  };
  // Auto-register so afterEach can stop any surviving jobs.
  registries.push(registry);
  return registry;
}

function makePrismaService() {
  return {
    $transaction: jest.fn().mockResolvedValue(undefined),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

// Registries created in each test — collected so afterEach can drain timers.
const registries: Array<{ _jobs: Map<string, any> }> = [];

describe('RoutineScheduleRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Stop every CronJob that was registered during the test so the worker
    // process exits cleanly (no "A worker process has failed to exit" warning).
    for (const registry of registries) {
      for (const job of registry._jobs.values()) {
        if (typeof job.stop === 'function') {
          job.stop();
        }
      }
      registry._jobs.clear();
    }
    registries.length = 0;
  });

  // ── reloadAll ─────────────────────────────────────────────────────────────

  describe('reloadAll() / onModuleInit', () => {
    it('registers a CronJob for each enabled config with a cron', async () => {
      const configs = [
        makeConfig({ key: 'review-draft', enabled: true, cron: '0 * * * *' }),
        makeConfig({ key: 'lead-scoring', enabled: true, cron: '30 * * * *' }),
      ];
      const configSvc = makeConfigService(configs);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.onModuleInit();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'routine:review-draft',
        expect.objectContaining({ start: expect.any(Function) }),
      );
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'routine:lead-scoring',
        expect.objectContaining({ start: expect.any(Function) }),
      );
    });

    it('skips disabled configs', async () => {
      const configs = [
        makeConfig({ key: 'review-draft', enabled: false, cron: '0 * * * *' }),
      ];
      const configSvc = makeConfigService(configs);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.onModuleInit();

      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('skips configs with no cron', async () => {
      const configs = [
        makeConfig({ key: 'review-draft', enabled: true, cron: null }),
      ];
      const configSvc = makeConfigService(configs);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.onModuleInit();

      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });
  });

  // ── reload ────────────────────────────────────────────────────────────────

  describe('reload(key)', () => {
    it('registers a job for enabled+cron config', async () => {
      const config = makeConfig({ key: 'review-draft', enabled: true, cron: '0 * * * *' });
      const configSvc = makeConfigService([config]);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.reload('review-draft');

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'routine:review-draft',
        expect.objectContaining({ start: expect.any(Function) }),
      );
    });

    it('removes job for disabled config', async () => {
      const config = makeConfig({ key: 'review-draft', enabled: false, cron: '0 * * * *' });
      const configSvc = makeConfigService([config]);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();
      // Pre-seed as if job was already registered
      schedulerRegistry.doesExist.mockReturnValue(true);

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.reload('review-draft');

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('routine:review-draft');
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('removes job for config with no cron', async () => {
      const config = makeConfig({ key: 'review-draft', enabled: true, cron: null });
      const configSvc = makeConfigService([config]);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();
      schedulerRegistry.doesExist.mockReturnValue(true);

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.reload('review-draft');

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('routine:review-draft');
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('catches and logs invalid cron without throwing', async () => {
      const config = makeConfig({ key: 'review-draft', enabled: true, cron: 'not-a-cron' });
      const configSvc = makeConfigService([config]);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      // Should NOT throw
      await expect(runner.reload('review-draft')).resolves.toBeUndefined();
      // No job registered because cron is invalid
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('deletes existing job before re-adding on reload', async () => {
      const config = makeConfig({ key: 'review-draft', enabled: true, cron: '0 * * * *' });
      const configSvc = makeConfigService([config]);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();
      // Pre-existing job
      schedulerRegistry.doesExist.mockReturnValue(true);

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      await runner.reload('review-draft');

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('routine:review-draft');
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'routine:review-draft',
        expect.any(Object),
      );
    });

    it('catches and logs addCronJob failure without throwing', async () => {
      const config = makeConfig({ key: 'review-draft', enabled: true, cron: '0 * * * *' });
      const configSvc = makeConfigService([config]);
      const triggerSvc = makeTriggerService();
      const schedulerRegistry = makeSchedulerRegistry();
      const prisma = makePrismaService();
      schedulerRegistry.addCronJob.mockImplementationOnce(() => {
        throw new Error('duplicate job name race');
      });

      const runner = new RoutineScheduleRunner(
        configSvc as any,
        triggerSvc as any,
        schedulerRegistry as any,
        prisma as any,
      );

      // Should NOT throw
      await expect(runner.reload('review-draft')).resolves.toBeUndefined();
    });
  });
});
