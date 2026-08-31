import { ResearchRunnerService } from './research-runner.service';
import { RESEARCH_MANUAL_KEY, RESEARCH_RUN_KIND } from './research-kinds';

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
  function setup(
    over: {
      mode?: 'SERVER' | 'MCP';
      built?: unknown;
      workerThrows?: boolean;
      modeThrows?: boolean;
      job?: typeof JOB;
    } = {},
  ) {
    let handler: (j: typeof JOB) => Promise<void> = async () => {};
    const lease = {
      modeFor: over.modeThrows
        ? jest.fn().mockRejectedValue(new Error('workspace row unreadable'))
        : jest.fn().mockResolvedValue(over.mode ?? 'MCP'),
      recordPlatformTakeover: jest.fn().mockResolvedValue(undefined),
    };
    const worker = {
      runProfile: jest.fn(async () => {
        if (over.workerThrows) throw new Error('anthropic exploded');
        return { runId: 'r1', researched: 3, staged: 3, duplicates: 0 };
      }),
    };
    const schedule = jest.fn().mockResolvedValue('job-1');
    const svc = new ResearchRunnerService(
      { schedule } as any,
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
    return { svc, lease, worker, schedule, run: () => handler(over.job ?? JOB) };
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

  /**
   * A MANUAL run is not a takeover of anything.
   *
   * "Run now" stamps `RESEARCH_MANUAL_KEY` precisely so the grace conjunct
   * skips the row, which means the job reaches this handler on an MCP-lane
   * workspace by DESIGN rather than by anybody's Claude declining it. Stamping
   * it would print "your Claude did not take the job, we ran it" over the
   * owner's own button press — a false alarm on the one panel line whose whole
   * value is being believed — and would add that run's vendor spend to the
   * week's takeover total.
   */
  it('records nothing for a run a human asked for, even on the MCP lane', async () => {
    const { lease, worker, run } = setup({
      mode: 'MCP',
      job: { ...JOB, payload: { profileId: 'p1', [RESEARCH_MANUAL_KEY]: true } },
    });

    await run();

    expect(worker.runProfile).toHaveBeenCalled();
    expect(lease.recordPlatformTakeover).not.toHaveBeenCalled();
  });

  /**
   * ...and it does not even ASK. The lane read is a hot workspace-row lookup
   * whose only consumer is the stamp; skipping it on a manual run is free.
   */
  it('does not consult the lane at all for a manual run', async () => {
    const { lease, run } = setup({
      mode: 'MCP',
      job: { ...JOB, payload: { profileId: 'p1', [RESEARCH_MANUAL_KEY]: true } },
    });

    await run();

    expect(lease.modeFor).not.toHaveBeenCalled();
  });

  /**
   * FAIL OPEN. Before this guard the lane read ran unguarded before
   * `worker.runProfile`, so a workspace-row read blip did not merely lose the
   * takeover LINE — it lost the research NIGHT: the throw skipped the run, the
   * job retried, and `maxAttempts: 2` put the second failure in the DLQ. That
   * is the silent stop this whole branch exists to remove, reintroduced one
   * layer up, and it would have been caused by the code that reports it.
   */
  it('runs the research anyway when the lane read throws', async () => {
    const { lease, worker, run } = setup({ modeThrows: true });

    await expect(run()).resolves.toBeUndefined();

    expect(worker.runProfile).toHaveBeenCalled();
    // Unknowable lane => no claim about who was taken over. Silence here is
    // correct: the alternative is asserting a takeover we cannot evidence.
    expect(lease.recordPlatformTakeover).not.toHaveBeenCalled();
  });
});

/**
 * "Run now" has to mean now.
 *
 * `enqueueNow` and the nightly cron write the same kind onto the same dedup
 * key, and the grace window in `ScheduledJobRunnerService.claimBatch` holds
 * every `research.run` row on an MCP-lane workspace for six hours. Without the
 * stamp, the exact workspace this branch creates — Claude connected by the
 * onboarding step, no scheduled task written yet, therefore AUTO resolving to
 * MCP — presses the button, is toasted "research started", and gets nothing
 * until 09:00.
 */
describe('ResearchRunnerService.enqueueNow — the manual stamp', () => {
  function make() {
    const schedule = jest.fn().mockResolvedValue('job-1');
    const svc = new ResearchRunnerService(
      { schedule } as any,
      { registerHandler: jest.fn() } as any,
      { buildJobs: jest.fn().mockResolvedValue([]), buildJob: jest.fn() } as any,
      { runProfile: jest.fn() } as any,
      { usage: jest.fn() } as any,
      { mayRunBackground: jest.fn().mockResolvedValue(true) } as any,
      { modeFor: jest.fn(), recordPlatformTakeover: jest.fn() } as any,
    );
    return { svc, schedule };
  }

  it('stamps the payload so the grace conjunct skips the row', async () => {
    const { svc, schedule } = make();

    await svc.enqueueNow('ws-1', 'p1');

    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        kind: RESEARCH_RUN_KIND,
        payload: { profileId: 'p1', [RESEARCH_MANUAL_KEY]: true },
      }),
    );
  });

  /**
   * The dedup key is UNCHANGED, and that is the point of using a payload flag
   * rather than a second kind: a "Run now" issued while tonight's held nightly
   * row is still PENDING collapses onto it and promotes it, instead of
   * creating a second row and researching — and paying for — the same profile
   * twice.
   */
  it('keeps the profile dedup key, so it collapses onto tonight held row', async () => {
    const { svc, schedule } = make();

    await svc.enqueueNow('ws-1', 'p1');

    expect(schedule.mock.calls[0][0].dedupKey).toBe('research:p1');
  });

  /** The NIGHTLY lane keeps first refusal — the exemption is for the button only. */
  it('the nightly fan-out is not stamped', async () => {
    const schedule = jest.fn().mockResolvedValue('job-9');
    const svc = new ResearchRunnerService(
      { schedule } as any,
      { registerHandler: jest.fn() } as any,
      {
        buildJobs: jest.fn().mockResolvedValue([{ workspaceId: 'ws-1', profile: { id: 'p1' } }]),
        buildJob: jest.fn(),
      } as any,
      { runProfile: jest.fn() } as any,
      { usage: jest.fn().mockResolvedValue({ limit: -1, used: 0 }) } as any,
      {
        mayRunBackground: jest.fn().mockResolvedValue(true),
        mayWorkspaceRunBackground: jest.fn().mockResolvedValue(true),
      } as any,
      { modeFor: jest.fn(), recordPlatformTakeover: jest.fn() } as any,
    );

    await svc.nightly();

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0].payload).toEqual({ profileId: 'p1' });
  });
});
