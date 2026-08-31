import { ResearchRunnerService } from './research-runner.service';

/**
 * The nightly lane spends real vendor money with nobody watching, and the only
 * brake it had was `hasBackgroundHeadroom` — which asks whether the CUSTOMER
 * has allowance left. On an unlimited plan that answers yes forever, so the
 * spend was bounded only by how many profiles somebody had created.
 *
 * These caps are the answer to "who says no on an unlimited plan".
 */
describe('ResearchRunnerService.nightly — absolute caps', () => {
  const UNLIMITED = { limit: -1, used: 0 };

  function setup(jobs: Array<{ workspaceId: string; profileId: string }>, platformOk = true) {
    const scheduledJob = { schedule: jest.fn().mockResolvedValue('job-1') };
    const svc = new ResearchRunnerService(
      scheduledJob as any,
      { registerHandler: jest.fn() } as any,
      {
        buildJobs: jest
          .fn()
          .mockResolvedValue(jobs.map((j) => ({ workspaceId: j.workspaceId, profile: { id: j.profileId } }))),
      } as any,
      {} as any,
      { usage: jest.fn().mockResolvedValue(UNLIMITED) } as any,
      { mayRunBackground: jest.fn().mockResolvedValue(platformOk) } as any,
      // The lane resolver / takeover recorder. Untouched by nightly(), which is
      // all this file covers; the handler side has its own spec.
      { modeFor: jest.fn(), recordPlatformTakeover: jest.fn() } as any,
    );
    return { svc, scheduledJob };
  }

  const jobsFor = (workspaceId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ workspaceId, profileId: `${workspaceId}-p${i}` }));

  it('caps how many runs one workspace can start in a night', async () => {
    // 25 profiles on an unlimited plan: every one of them used to be enqueued.
    const { svc, scheduledJob } = setup(jobsFor('ws-1', 25));
    await svc.nightly();
    expect(scheduledJob.schedule).toHaveBeenCalledTimes(10);
  });

  it('caps the whole night across workspaces', async () => {
    const { svc, scheduledJob } = setup([
      ...jobsFor('ws-1', 10),
      ...jobsFor('ws-2', 10),
      ...jobsFor('ws-3', 10),
      ...jobsFor('ws-4', 10),
      ...jobsFor('ws-5', 10),
    ]);
    await svc.nightly();
    // Per-workspace alone would allow 50; the global ceiling is what stops it.
    expect(scheduledJob.schedule).toHaveBeenCalledTimes(40);
  });

  it('still runs everything when a workspace is under the caps', async () => {
    const { svc, scheduledJob } = setup(jobsFor('ws-1', 3));
    await svc.nightly();
    expect(scheduledJob.schedule).toHaveBeenCalledTimes(3);
  });

  it('spreads the global budget rather than letting one workspace take it all', async () => {
    const { svc, scheduledJob } = setup([...jobsFor('ws-1', 30), ...jobsFor('ws-2', 30)]);
    await svc.nightly();
    const byWs = scheduledJob.schedule.mock.calls.reduce<Record<string, number>>((acc, [arg]) => {
      acc[arg.workspaceId] = (acc[arg.workspaceId] ?? 0) + 1;
      return acc;
    }, {});
    expect(byWs['ws-1']).toBe(10);
    expect(byWs['ws-2']).toBe(10);
  });

  it('does not start a single run once OUR platform cap is blown', async () => {
    // The customer-side guards all pass here (unlimited plan, under the
    // per-workspace cap). This is the only one that can say no on behalf of
    // the vendor bill.
    const { svc, scheduledJob } = setup(jobsFor('ws-1', 5), false);
    await svc.nightly();
    expect(scheduledJob.schedule).not.toHaveBeenCalled();
  });

  it('reports what it deferred — a silently halved night reads as "found nothing"', async () => {
    const { svc } = setup(jobsFor('ws-1', 25));
    const logged: string[] = [];
    jest
      .spyOn((svc as any).logger, 'log')
      .mockImplementation((m: unknown) => void logged.push(String(m)));
    await svc.nightly();
    expect(logged.join(' ')).toMatch(/enqueued 10\/25/);
    expect(logged.join(' ')).toMatch(/deferred 15/);
  });
});
