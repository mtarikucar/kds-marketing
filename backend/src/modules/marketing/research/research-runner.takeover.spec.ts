import { ResearchRunnerService } from './research-runner.service';
import { RESEARCH_RUN_KIND } from './research-kinds';

const WS = 'ws-1';
const JOB = { id: 'job-1', workspaceId: WS, kind: RESEARCH_RUN_KIND, payload: { profileId: 'p1' }, attempts: 0 };

/**
 * When the platform drains a job the owner's Claude was asked first, it says so.
 *
 * The grace window in `ScheduledJobRunnerService.claimBatch` is what lets this
 * job reach the handler at all: under MCP the platform stays off it for
 * `RESEARCH_MCP_GRACE_HOURS`, and after that takes it anyway. So arriving here
 * on an MCP-lane workspace IS the takeover, and recording it is the difference
 * between a safety net and a silent subsidy.
 */
describe('ResearchRunnerService.handle — recording the takeover', () => {
  function setup(over: { mode?: 'SERVER' | 'MCP'; built?: unknown; workerThrows?: boolean } = {}) {
    let handler: (j: typeof JOB) => Promise<void> = async () => {};
    const lease = {
      modeFor: jest.fn().mockResolvedValue(over.mode ?? 'MCP'),
      recordPlatformTakeover: jest.fn().mockResolvedValue(undefined),
    };
    const worker = {
      runProfile: jest.fn(async () => {
        if (over.workerThrows) throw new Error('anthropic exploded');
        return { runId: 'r1', researched: 3, staged: 3, duplicates: 0 };
      }),
    };
    const svc = new ResearchRunnerService(
      { schedule: jest.fn() } as any,
      {
        registerHandler: jest.fn((_k: string, fn: typeof handler) => {
          handler = fn;
        }),
      } as any,
      {
        buildJobs: jest.fn().mockResolvedValue([]),
        buildJob: jest
          .fn()
          .mockResolvedValue(over.built === undefined ? { workspaceId: WS, profile: { id: 'p1' } } : over.built),
      } as any,
      worker as any,
      { usage: jest.fn() } as any,
      { mayRunBackground: jest.fn() } as any,
      lease as any,
    );
    svc.onModuleInit();
    return { svc, lease, worker, run: () => handler(JOB) };
  }

  it('records a takeover when the lane was the owner Claude', async () => {
    const { lease, worker, run } = setup({ mode: 'MCP' });

    await run();

    expect(worker.runProfile).toHaveBeenCalled();
    expect(lease.recordPlatformTakeover).toHaveBeenCalledWith(WS, 'job-1', expect.any(Date));
  });

  /**
   * A SERVER workspace was never reserved for anybody, so nothing was taken
   * over. Recording one here would put a "your scheduled task is broken"
   * warning on the panel of every customer who never wanted MCP at all.
   */
  it('records nothing on a SERVER-lane workspace', async () => {
    const { lease, run } = setup({ mode: 'SERVER' });
    await run();
    expect(lease.recordPlatformTakeover).not.toHaveBeenCalled();
  });

  /**
   * A run that FAILED still spent money before it failed, and the retry
   * accumulates onto the same row. Recording only on success would report a
   * takeover night as free.
   */
  it('records the takeover even when the run itself fails, and rethrows', async () => {
    const { lease, run } = setup({ mode: 'MCP', workerThrows: true });

    await expect(run()).rejects.toThrow(/exploded/);

    expect(lease.recordPlatformTakeover).toHaveBeenCalledWith(WS, 'job-1', expect.any(Date));
  });

  /**
   * Bookkeeping must never be able to fail the job. A takeover the panel does
   * not learn about is bad; a research night retried three times and DLQ'd
   * because a JSON stamp failed is worse.
   */
  it('never lets the recording failure disturb the job', async () => {
    const { lease, run } = setup({ mode: 'MCP' });
    lease.recordPlatformTakeover.mockRejectedValue(new Error('db gone'));

    await expect(run()).resolves.toBeUndefined();
  });

  it('records nothing when the profile was paused and no work ran', async () => {
    const { lease, worker, run } = setup({ mode: 'MCP', built: null });

    await run();

    expect(worker.runProfile).not.toHaveBeenCalled();
    expect(lease.recordPlatformTakeover).not.toHaveBeenCalled();
  });

  it('asks the lane for THIS job workspace, never a global setting', async () => {
    const { lease, run } = setup({ mode: 'MCP' });
    await run();
    expect(lease.modeFor).toHaveBeenCalledWith(WS);
  });
});
