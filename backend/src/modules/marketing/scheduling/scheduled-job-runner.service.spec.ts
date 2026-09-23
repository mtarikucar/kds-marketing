jest.mock('../../../common/scheduling/advisory-lock', () => ({
  // Run the critical section inline (single-replica assumption is the
  // production concern, not this unit's).
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => {
    await cb();
  }),
}));

import {
  ScheduledJobRunnerService,
  DISPATCH_BUDGET_MS,
  KIND_DISPATCH_CAP,
} from './scheduled-job-runner.service';
import { Prisma } from '@prisma/client';
import { RESEARCH_RUN_KIND } from '../research/research-kinds';
import {
  MCP_ACTIVITY_AGENT,
  MCP_CONNECTION_STALE_MS,
  RESEARCH_MCP_GRACE_MS,
} from '../research/research-execution';

/**
 * Claim → dispatch → outcome routing of the delayed-work runner. The DLQ and
 * backoff arithmetic are the load-bearing parts: a transient failure must
 * back off and stay PENDING; an unknown kind or an exhausted retry budget
 * must terminate as FAILED so it never spins forever.
 */
describe('ScheduledJobRunnerService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let runner: ScheduledJobRunnerService;

  function claim(jobs: any[]) {
    prisma.$queryRaw.mockResolvedValue(jobs);
  }

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ aiSpendPolicy: {} }) },
      scheduledJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ maxAttempts: 5 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      // reapStuck batches its passes in a transaction; run them so a rejected
      // $executeRaw surfaces (mirrors the array form awaiting all ops).
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    runner = new ScheduledJobRunnerService(prisma as any);
  });

  it('registers handlers and rejects a duplicate kind', () => {
    runner.registerHandler('k', async () => {});
    expect(runner.registeredKinds()).toContain('k');
    expect(() => runner.registerHandler('k', async () => {})).toThrow(/already registered/);
  });

  it.each([
    ['conversation.ai_reply', {}, { 'conversation.reply': { enabled: false } }],
    ['conversation.ai_reply', { reason: 'followup' }, { 'conversation.followup': { enabled: false } }],
    ['conversation.ai_reply', {}, { 'conversation.reply': { provider: 'MCP' } }],
    ['conversation.followup', {}, { 'conversation.followup': { enabled: false } }],
    ['research.run', {}, { 'research.turn': { provider: 'MCP' } }],
    ['research.run', {}, { 'research.qualify': { enabled: false } }],
  ])('returns an existing %s claim to PENDING when policy prevents execution: %p %p', async (kind, payload, jobs) => {
    prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs } });
    const handler = jest.fn();
    runner.registerHandler(kind as string, handler);
    claim([{ id: 'policy-job', workspaceId: WS, kind, payload, attempts: 2 }]);
    await runner.tick();
    expect(handler).not.toHaveBeenCalled();
    expect(prisma.scheduledJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', lockedAt: null }) }));
    expect(prisma.scheduledJob.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attempts: 3 }) }));
  });

  it('does not mark a running action complete if the owner disabled it during the handler', async () => {
    runner.registerHandler('research.run', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'research.qualify': { enabled: false } } } });
    });
    claim([{ id: 'policy-job', workspaceId: WS, kind: 'research.run', payload: {}, attempts: 0 }]);
    await runner.tick();
    expect(prisma.scheduledJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
    expect(prisma.scheduledJob.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DONE' }) }));
  });

  it('allows a due MCP follow-up trigger to hand off without running a model', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'conversation.reply': { enabled: false }, 'conversation.followup': { enabled: true, provider: 'MCP' } } } });
    const handoff = jest.fn();
    runner.registerHandler('conversation.followup', handoff);
    claim([{ id: 'policy-job', workspaceId: WS, kind: 'conversation.followup', payload: {}, attempts: 0 }]);
    await runner.tick();
    expect(handoff).toHaveBeenCalled();
  });

  it('dispatches a claimed job to its handler and marks it DONE', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    runner.registerHandler('k', handler);
    claim([{ id: 'j1', workspaceId: WS, kind: 'k', payload: { a: 1 }, attempts: 0 }]);

    await runner.tick();

    expect(handler).toHaveBeenCalledWith({
      id: 'j1',
      workspaceId: WS,
      kind: 'k',
      payload: { a: 1 },
      attempts: 0,
    });
    expect(prisma.scheduledJob.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { status: 'DONE', completedAt: expect.any(Date), lastError: null },
    });
  });

  it('FAILs a job whose kind has no registered handler (code regression, not transient)', async () => {
    claim([{ id: 'j2', workspaceId: WS, kind: 'ghost', payload: {}, attempts: 0 }]);

    await runner.tick();

    const call = prisma.scheduledJob.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'j2' });
    expect(call.data.status).toBe('FAILED');
    expect(call.data.lastError).toMatch(/no handler/);
  });

  /** The status-carrying bookkeeping update (skips the pre-handler lockedAt heartbeat). */
  const statusCall = () =>
    prisma.scheduledJob.update.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.data && 'status' in c.data);

  it('backs off a transient failure: stays PENDING with attempts+1 and a future runAt', async () => {
    runner.registerHandler('k', async () => {
      throw new Error('boom');
    });
    claim([{ id: 'j3', workspaceId: WS, kind: 'k', payload: {}, attempts: 0 }]);

    await runner.tick();

    const call = statusCall();
    expect(call.where).toEqual({ id: 'j3' });
    expect(call.data.status).toBe('PENDING');
    expect(call.data.attempts).toBe(1);
    expect(call.data.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(call.data.lastError).toMatch(/boom/);
  });

  it('DLQs to FAILED once the retry budget is exhausted', async () => {
    prisma.scheduledJob.findUnique.mockResolvedValue({ maxAttempts: 5 });
    runner.registerHandler('k', async () => {
      throw new Error('still broken');
    });
    // attempts already 4 → this run makes it 5 == maxAttempts → FAILED
    claim([{ id: 'j4', workspaceId: WS, kind: 'k', payload: {}, attempts: 4 }]);

    await runner.tick();

    const call = statusCall();
    expect(call.data.status).toBe('FAILED');
    expect(call.data.attempts).toBe(5);
  });

  it('re-stamps lockedAt (heartbeat) immediately before invoking each handler', async () => {
    // claimBatch stamps lockedAt once for the whole batch; a row queued behind
    // slow handlers for >15 min would look stale to another replica's reaper
    // and get double-run. The pre-handler heartbeat keeps live claims fresh.
    const order: string[] = [];
    prisma.scheduledJob.update.mockImplementation((args: any) => {
      order.push('data' in args && 'lockedAt' in args.data && !('status' in args.data) ? 'heartbeat' : 'bookkeeping');
      return Promise.resolve({});
    });
    runner.registerHandler('k', async () => {
      order.push('handler');
    });
    claim([{ id: 'j1', workspaceId: WS, kind: 'k', payload: {}, attempts: 0 }]);

    await runner.tick();

    expect(order).toEqual(['heartbeat', 'handler', 'bookkeeping']);
  });

  it('skips an overlapping tick while the previous one is still running (no in-process double-claim)', async () => {
    // A long batch can outlast the minute interval; session advisory locks are
    // re-entrant per connection, so only this in-process guard reliably stops
    // an overlapping tick from reaping + double-running the first tick's jobs.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    runner.registerHandler('slow', async () => {
      await gate;
    });
    claim([{ id: 'j1', workspaceId: WS, kind: 'slow', payload: {}, attempts: 0 }]);

    const first = runner.tick(); // enters, blocks in the handler
    await new Promise((r) => setImmediate(r));
    const claimsBefore = prisma.$queryRaw.mock.calls.length;
    await runner.tick(); // overlapping tick must return immediately
    expect(prisma.$queryRaw.mock.calls.length).toBe(claimsBefore); // no second claimBatch

    release();
    await first;
  });

  it('reaps stuck rows via conflict-safe SQL before claiming', async () => {
    await runner.tick();
    // Three-pass reap (retire-successor-covered, retire-losers, revive-survivors)
    // wrapped in a transaction so REVIVE can never duplicate a (kind,dedupKey).
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('isolates a reaper failure so claiming still runs (no system-wide wedge)', async () => {
    prisma.$executeRaw.mockRejectedValueOnce(new Error('unique_violation'));
    const handler = jest.fn().mockResolvedValue(undefined);
    runner.registerHandler('k', handler);
    claim([{ id: 'j1', workspaceId: WS, kind: 'k', payload: {}, attempts: 0 }]);

    await expect(runner.tick()).resolves.toBeUndefined();
    // Dispatch proceeded despite the reaper throwing.
    expect(handler).toHaveBeenCalled();
  });

  it('isolates a single job dispatch failure so the rest of the batch runs', async () => {
    const bad = jest.fn().mockRejectedValue(new Error('boom'));
    const good = jest.fn().mockResolvedValue(undefined);
    runner.registerHandler('bad', bad);
    runner.registerHandler('good', good);
    // Make the FAILED-bookkeeping write throw too, so run() itself escapes.
    prisma.scheduledJob.update.mockRejectedValueOnce(new Error('db blip'));
    claim([
      { id: 'j-bad', workspaceId: WS, kind: 'bad', payload: {}, attempts: 0 },
      { id: 'j-good', workspaceId: WS, kind: 'good', payload: {}, attempts: 0 },
    ]);

    await runner.tick();
    expect(good).toHaveBeenCalled(); // not starved by the first job's failure
  });

  it('advances a self-rescheduling chain in place (PENDING, new runAt) instead of marking DONE', async () => {
    const runAt = new Date(Date.now() + 60_000);
    runner.registerHandler('chain', async () => ({ reschedule: { runAt, payload: { step: 2 } } }));
    claim([{ id: 'jc', workspaceId: WS, kind: 'chain', payload: { step: 1 }, attempts: 3 }]);

    await runner.tick();

    expect(prisma.scheduledJob.update).toHaveBeenCalledWith({
      where: { id: 'jc' },
      data: { status: 'PENDING', runAt, payload: { step: 2 }, lockedAt: null, attempts: 0, lastError: null },
    });
  });
});

/**
 * The one kind this generic runner is NOT always allowed to claim.
 *
 * A workspace on `researchExecution: 'MCP'` has said its nightly research is
 * drained by its OWN Claude, over MCP, on its own Anthropic subscription — the
 * entire point being that the platform stops paying for 86% of its model bill.
 * The cron still enqueues those jobs, unchanged. If this runner claims them
 * anyway they are executed in-process against the platform's key within sixty
 * seconds of being written, the owner's scheduled drainer never finds anything
 * to lease, and the feature silently does not exist while looking like it
 * works.
 *
 * The exclusion is read LIVE off the workspace rather than stamped on the row
 * at enqueue time. Stamping would be tidier layering but leaves a real bug:
 * rows stamped MCP would be orphaned forever the moment an owner switched back
 * to SERVER, with no drainer on either side and nothing to notice it.
 */
describe('ScheduledJobRunnerService — leaves an MCP workspace its research jobs', () => {
  let prisma: any;
  let runner: ScheduledJobRunnerService;

  beforeEach(() => {
    prisma = {
      scheduledJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ maxAttempts: 5 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    runner = new ScheduledJobRunnerService(prisma as any);
  });

  /** The claim SQL, reassembled from the tagged-template call. */
  function claimSql(): string {
    const [strings] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return strings.join(' ? ');
  }
  function claimValues(): unknown[] {
    const [, ...values] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return values;
  }

  it('excludes research jobs of MCP-mode workspaces from the claim itself', async () => {
    await runner.tick();

    const sql = claimSql();
    // Read live off the workspace, not off a stamped column on the row.
    expect(sql).toContain('workspaces');
    expect(sql).toContain('researchExecution');
    expect(sql).toContain("'MCP'");
    // Scoped to the research kind: an MCP-research workspace still gets its
    // campaigns, follow-ups, imports and reminders drained by this runner.
    expect(claimValues()).toContain(RESEARCH_RUN_KIND);
  });

  it('still claims every OTHER kind, and research for a SERVER workspace', async () => {
    // The exclusion must be a conjunction of kind AND mode — either half on
    // its own is a different, much bigger, outage.
    const sql = (await runner.tick(), claimSql()).replace(/\s+/g, ' ');
    expect(sql).toMatch(/NOT\s*\(/i);
    expect(sql).toMatch(/"kind"\s*=/);
    expect(sql).toMatch(/EXISTS/i);
  });
});

/**
 * ...but only while the owner's Claude still has first refusal.
 *
 * The mode stopped meaning "who drains" and started meaning "who is asked
 * first" (`research-execution.ts`). A workspace that connected Claude once and
 * never scheduled a drainer used to have its research silently stop; now the
 * platform takes the job back `RESEARCH_MCP_GRACE_HOURS` after it was enqueued.
 *
 * The window belongs in THIS predicate, beside the mode, because the claim is
 * the only place the platform decides to touch the row at all. Everything below
 * asserts on the emitted SQL — whether it is valid Postgres, and whether it
 * excludes exactly the right rows, is settled in
 * `research-mcp-fallback.realdb.e2e-spec.ts` against a real database.
 */
describe('ScheduledJobRunnerService — first refusal expires', () => {
  let prisma: any;
  let runner: ScheduledJobRunnerService;

  beforeEach(() => {
    prisma = {
      scheduledJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ maxAttempts: 5 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    runner = new ScheduledJobRunnerService(prisma as any);
  });

  function claimCall() {
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return { sql: strings.join(' ? ').replace(/\s+/g, ' '), values };
  }

  it('bounds the exclusion by createdAt, so an unclaimed job comes back to us', async () => {
    await runner.tick();
    const { sql } = claimCall();
    expect(sql).toMatch(/"createdAt"\s*>/);
  });

  it('measures the grace window from RESEARCH_MCP_GRACE_MS, not a literal', async () => {
    const before = Date.now();
    await runner.tick();
    const after = Date.now();

    const { values } = claimCall();
    const cutoffs = values.filter((v): v is Date => v instanceof Date);
    // now, and now - GRACE, and now - STALE.
    const grace = cutoffs.find(
      (d) =>
        d.getTime() >= before - RESEARCH_MCP_GRACE_MS && d.getTime() <= after - RESEARCH_MCP_GRACE_MS,
    );
    expect(grace).toBeDefined();
  });

  it('treats AUTO as MCP only when an MCP tool call happened recently', async () => {
    await runner.tick();
    const { sql, values } = claimCall();

    // AUTO resolves against real MCP traffic — an agent_runs row this
    // workspace's own connector wrote.
    expect(sql).toContain("'AUTO'");
    expect(sql).toContain('agent_runs');
    expect(values).toContain(MCP_ACTIVITY_AGENT);

    const before = Date.now();
    const stale = values.find(
      (v): v is Date =>
        v instanceof Date && Math.abs(v.getTime() - (before - MCP_CONNECTION_STALE_MS)) < 5_000,
    );
    expect(stale).toBeDefined();
  });

  it('keeps the whole exclusion conjoined to the research kind', async () => {
    await runner.tick();
    const { sql, values } = claimCall();
    // One NOT(...) whose first conjunct is the kind: every other kind, for
    // every workspace in every mode, is unaffected by all of the above.
    expect(sql).toMatch(/NOT \( s\."kind" = \?/);
    expect(values).toContain(RESEARCH_RUN_KIND);
  });
});

/**
 * Fairness: one tenant's work may not hold the whole platform's queue.
 *
 * The runner claims up to a hundred due rows and runs them SEQUENTIALLY under
 * ONE global advisory lock, so a campaign's fifty SMTP round-trips used to keep
 * every other tenant's AI reply, workflow resume and booking reminder waiting
 * for as long as they took (`batches-stall-runner`).
 *
 * Two bounds, and one rule that makes both safe: whatever this tick does not
 * dispatch must be handed BACK to the queue explicitly. `claimBatch` already
 * flipped those rows to RUNNING, so simply abandoning them would hide them
 * until `reapStuck` revives them fifteen minutes later — turning a two-minute
 * delay into a quarter-hour one.
 */
describe('ScheduledJobRunnerService — one tenant cannot hold the tick', () => {
  const WS = 'ws-1';
  let prisma: any;
  let runner: ScheduledJobRunnerService;

  function claim(jobs: any[]) {
    prisma.$queryRaw.mockResolvedValue(jobs);
  }
  const job = (id: string, kind: string) => ({ id, workspaceId: WS, kind, payload: {}, attempts: 0 });
  /** The release write: RUNNING rows this tick never got to. */
  const releaseCall = () =>
    prisma.scheduledJob.updateMany.mock.calls.map((c: any[]) => c[0]).find((c: any) => c?.data?.status === 'PENDING');

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ aiSpendPolicy: {} }) },
      scheduledJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ maxAttempts: 5 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    runner = new ScheduledJobRunnerService(prisma as any);
  });

  afterEach(() => jest.restoreAllMocks());

  /** A handler that costs `ms` of wall clock, on a clock the test owns. */
  function slowHandler(ms: number): jest.Mock {
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    return jest.fn(async () => {
      clock += ms;
    });
  }

  it('stops dispatching at the wall-clock deadline instead of holding the lock for the whole batch', async () => {
    const handler = slowHandler(DISPATCH_BUDGET_MS / 2 + 1);
    runner.registerHandler('slow', handler);
    claim([job('j1', 'slow'), job('j2', 'slow'), job('j3', 'slow'), job('j4', 'slow')]);

    await runner.tick();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(releaseCall()).toEqual({
      where: { workspaceId: WS, id: { in: ['j3', 'j4'] }, status: 'RUNNING' },
      data: { status: 'PENDING', lockedAt: null },
    });
  });

  it('breaks rather than returns: the tail that hands the remainder back still runs', async () => {
    // A `return` out of the dispatch loop would skip the release below and
    // leave those rows RUNNING and invisible until the 15-minute reaper.
    const handler = slowHandler(DISPATCH_BUDGET_MS * 2);
    runner.registerHandler('slow', handler);
    claim([job('j1', 'slow'), job('j2', 'slow')]);

    await runner.tick();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(releaseCall()?.where.id.in).toEqual(['j2']);
  });

  it('always dispatches the first claimed job, so a tick can never make zero progress', async () => {
    const handler = slowHandler(DISPATCH_BUDGET_MS * 10);
    runner.registerHandler('slow', handler);
    claim([job('j1', 'slow')]);

    await runner.tick();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(releaseCall()).toBeUndefined();
  });

  it('hands the remainder back untouched — no attempt consumed, no lastError, same runAt', async () => {
    const handler = slowHandler(DISPATCH_BUDGET_MS * 2);
    runner.registerHandler('slow', handler);
    claim([job('j1', 'slow'), job('j2', 'slow')]);

    await runner.tick();

    // A deferral is not a failure: these rows were never attempted, so the
    // release writes exactly the two columns the claim wrote and nothing else.
    expect(Object.keys(releaseCall()!.data).sort()).toEqual(['lockedAt', 'status']);
  });

  it('caps one kind per claim, so a campaign burst cannot starve another tenant behind it', async () => {
    const bulk = jest.fn().mockResolvedValue(undefined);
    const reminder = jest.fn().mockResolvedValue(undefined);
    runner.registerHandler('campaign.batch', bulk);
    runner.registerHandler('booking.reminder', reminder);
    const overflow = 3;
    claim([
      ...Array.from({ length: KIND_DISPATCH_CAP + overflow }, (_, i) => job(`b${i}`, 'campaign.batch')),
      // Last in the claim, i.e. the row a naive runner reaches only after every
      // campaign row above it has finished.
      job('reminder', 'booking.reminder'),
    ]);

    await runner.tick();

    expect(bulk).toHaveBeenCalledTimes(KIND_DISPATCH_CAP);
    expect(reminder).toHaveBeenCalled();
    expect(releaseCall()?.where.id.in).toEqual(
      Array.from({ length: overflow }, (_, i) => `b${KIND_DISPATCH_CAP + i}`),
    );
  });

  it('writes nothing back when the whole claim was dispatched (never resurrects a finished row)', async () => {
    runner.registerHandler('k', jest.fn().mockResolvedValue(undefined));
    claim([job('j1', 'k'), job('j2', 'k')]);

    await runner.tick();

    expect(releaseCall()).toBeUndefined();
  });

  it('isolates a failed release so the tick still ends cleanly (the reaper is the backstop)', async () => {
    prisma.scheduledJob.updateMany.mockRejectedValue(new Error('db blip'));
    const handler = slowHandler(DISPATCH_BUDGET_MS * 2);
    runner.registerHandler('slow', handler);
    claim([job('j1', 'slow'), job('j2', 'slow')]);

    await expect(runner.tick()).resolves.toBeUndefined();
  });

  /**
   * The release flips RUNNING back to PENDING, and that transition can hit the
   * partial-unique index `scheduled_jobs_pending_dedup (kind, dedupKey) WHERE
   * status = 'PENDING'`: `ScheduledJobService.schedule()` only collapses onto a
   * row that is still PENDING, so while this tick held a row RUNNING an inbound
   * message was free to create a PENDING successor for the same conversation.
   *
   * One conflict must cost exactly that one row — not the rest of the tenant's
   * deferred batch, and certainly not every tenant after it in the map.
   */
  describe('a dedup conflict during the release', () => {
    const P2002 = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: 'scheduled_jobs_pending_dedup' },
      });

    const otherJob = (id: string, workspaceId: string) => ({
      id,
      workspaceId,
      kind: 'conversation.ai_reply',
      payload: {},
      attempts: 0,
    });
    /** Every release write, batched or per-id, in call order. */
    const releaseCalls = () =>
      prisma.scheduledJob.updateMany.mock.calls
        .map((c: any[]) => c[0])
        .filter((c: any) => c?.data?.status === 'PENDING');

    it('releases the other tenants when one tenant’s write conflicts', async () => {
      prisma.scheduledJob.updateMany.mockImplementation(async (args: any) => {
        if (args.where.workspaceId === 'ws-a') throw P2002();
        return { count: 1 };
      });
      const handler = slowHandler(DISPATCH_BUDGET_MS * 2);
      runner.registerHandler('conversation.ai_reply', handler);
      claim([
        job('first', 'slow'),
        otherJob('a1', 'ws-a'),
        otherJob('b1', 'ws-b'),
        otherJob('c1', 'ws-c'),
      ]);
      runner.registerHandler('slow', handler);

      await runner.tick();

      const released = releaseCalls().map((c: any) => c.where);
      expect(released.some((w: any) => w.workspaceId === 'ws-b')).toBe(true);
      expect(released.some((w: any) => w.workspaceId === 'ws-c')).toBe(true);
    });

    it('retries the conflicting tenant one row at a time, so only the conflicting row is left behind', async () => {
      prisma.scheduledJob.updateMany.mockImplementation(async (args: any) => {
        const id = args.where.id;
        // The batched write for ws-a, and the single id that really conflicts.
        if (id?.in?.includes('a1') || id === 'a1') throw P2002();
        return { count: 1 };
      });
      const handler = slowHandler(DISPATCH_BUDGET_MS * 2);
      runner.registerHandler('slow', handler);
      runner.registerHandler('conversation.ai_reply', handler);
      claim([job('first', 'slow'), otherJob('a1', 'ws-a'), otherJob('a2', 'ws-a')]);

      await runner.tick();

      // a2 has nothing to collide with and must be back in the queue now,
      // rather than waiting fifteen minutes for the reaper.
      expect(releaseCalls()).toContainEqual({
        where: { workspaceId: 'ws-a', id: 'a2', status: 'RUNNING' },
        data: { status: 'PENDING', lockedAt: null },
      });
    });

    it('still ends the tick cleanly when every release conflicts', async () => {
      prisma.scheduledJob.updateMany.mockRejectedValue(P2002());
      const handler = slowHandler(DISPATCH_BUDGET_MS * 2);
      runner.registerHandler('slow', handler);
      claim([job('j1', 'slow'), job('j2', 'slow')]);

      await expect(runner.tick()).resolves.toBeUndefined();
    });
  });
});
