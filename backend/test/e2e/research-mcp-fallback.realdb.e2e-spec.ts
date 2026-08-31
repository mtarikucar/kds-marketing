import { randomUUID } from 'crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ResearchLeaseService } from '../../src/modules/marketing/research/research-lease.service';
import { RESEARCH_RUN_KIND } from '../../src/modules/marketing/research/research-kinds';
import {
  MCP_ACTIVITY_AGENT,
  MCP_CONNECTION_STALE_MS,
  RESEARCH_MCP_GRACE_MS,
  effectiveResearchExecution,
} from '../../src/modules/marketing/research/research-execution';
import { ScheduledJobRunnerService } from '../../src/modules/marketing/scheduling/scheduled-job-runner.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The FALLBACK, against real Postgres.
 *
 * v2.286.0 made `researchExecution: 'MCP'` a hard switch, and a workspace that
 * connected Claude without scheduling a drainer simply stopped researching. The
 * grace window turns that into "who is asked FIRST", which is what makes
 * auto-defaulting to MCP safe at all. Three things only real SQL can settle:
 *
 * 1. **The predicate is one raw `NOT (...)` with three nested `EXISTS` inside a
 *    `FOR UPDATE SKIP LOCKED` subquery.** Whether it is even valid Postgres —
 *    let alone whether it excludes exactly the rows inside the window and no
 *    others — is not a question a jest mock can answer.
 *
 * 2. **The same rule is written twice.** `claimBatch` decides in SQL and
 *    `ResearchLeaseService.modeFor` decides in TypeScript, and neither can call
 *    the other. The matrix below runs BOTH over the same rows, so a drift shows
 *    up as a disagreement rather than as a queue nobody drains at all.
 *
 * 3. **The tenant boundary is hand-written.** `scheduled_jobs` and `agent_runs`
 *    carry bare `workspaceId` columns with no foreign key. Every fixture here is
 *    CROSS-STAMPED — the neighbour has its own queued job, its own MCP traffic
 *    and its own lane — so a missing `workspaceId` predicate produces the WRONG
 *    answer rather than no answer.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Research MCP fallback — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let lease: ResearchLeaseService;
  let runner: ScheduledJobRunnerService;

  const SEED = `mcpfall-${randomUUID().slice(0, 8)}`;

  const wsAuto = randomUUID(); // AUTO — the workspace under test
  const wsNeighbour = randomUUID(); // AUTO, with MCP traffic and its own job
  const wsMcp = randomUUID(); // explicit MCP
  const wsServer = randomUUID(); // explicit SERVER

  const ALL = [wsAuto, wsNeighbour, wsMcp, wsServer];
  const created: string[] = [];

  const INSIDE = () => new Date(Date.now() - RESEARCH_MCP_GRACE_MS / 2);
  const OUTSIDE = () => new Date(Date.now() - RESEARCH_MCP_GRACE_MS - 60_000);

  const job = async (
    workspaceId: string,
    over: { kind?: string; createdAt?: Date; status?: string } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await prisma.scheduledJob.create({
      data: {
        id,
        workspaceId,
        kind: over.kind ?? RESEARCH_RUN_KIND,
        runAt: new Date(Date.now() - 60_000),
        payload: { profileId: `${SEED}-p` },
        status: over.status ?? 'PENDING',
        createdAt: over.createdAt ?? INSIDE(),
      },
    });
    created.push(id);
    return id;
  };

  const mcpRun = async (workspaceId: string, startedAt: Date): Promise<void> => {
    await prisma.agentRun.create({
      data: { workspaceId, agent: MCP_ACTIVITY_AGENT, goal: `${SEED}-tool`, startedAt },
    });
  };

  const setLane = (workspaceId: string, researchExecution: string) =>
    prisma.workspace.update({ where: { id: workspaceId }, data: { researchExecution } as never });

  /** The claim, run for real. Returns the ids it actually took. */
  const claim = async (): Promise<string[]> => {
    const rows = await (
      runner as unknown as { claimBatch: () => Promise<Array<{ id: string }>> }
    ).claimBatch();
    return rows.map((r) => r.id);
  };

  /** Put back whatever a claim swallowed, so the next case starts clean. */
  const restore = async (): Promise<void> => {
    await prisma.scheduledJob.updateMany({
      where: { id: { in: created } },
      data: { status: 'PENDING', lockedAt: null },
    });
  };

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    ({ app, prisma } = await createRealDbTestApp());
    lease = app.get(ResearchLeaseService);
    runner = app.get(ScheduledJobRunnerService);

    // Silence every cron. The live scheduled-job runner fires once a minute and
    // would claim these fixtures mid-assertion; `claimBatch` is invoked directly
    // so the SQL is what is under test, not a race with the scheduler.
    const scheduler = app.get(SchedulerRegistry);
    for (const [, cron] of scheduler.getCronJobs()) {
      try {
        (cron as { stop?: () => void }).stop?.();
      } catch {
        /* a cron that will not stop is not this spec's problem */
      }
    }

    await prisma.workspace.createMany({
      data: [
        {
          id: wsAuto,
          slug: `${SEED}-auto`,
          name: 'Fall Auto',
          productName: 'A',
          researchExecution: 'AUTO',
        },
        {
          id: wsNeighbour,
          slug: `${SEED}-nb`,
          name: 'Fall Neighbour',
          productName: 'N',
          researchExecution: 'AUTO',
        },
        {
          id: wsMcp,
          slug: `${SEED}-mcp`,
          name: 'Fall Mcp',
          productName: 'M',
          researchExecution: 'MCP',
        },
        {
          id: wsServer,
          slug: `${SEED}-srv`,
          name: 'Fall Srv',
          productName: 'S',
          researchExecution: 'SERVER',
        },
      ] as never,
    });
  });

  afterEach(async () => {
    if (!realDbEnabled() || !prisma) return;
    await prisma.scheduledJob.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    created.length = 0;
    await prisma.agentRun.deleteMany({ where: { workspaceId: { in: ALL } } }).catch(() => undefined);
    await prisma.aiUsageLog.deleteMany({ where: { workspaceId: { in: ALL } } }).catch(() => undefined);
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    try {
      if (!prisma) return;
      await prisma.scheduledJob
        .deleteMany({ where: { workspaceId: { in: ALL } } })
        .catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { workspaceId: { in: ALL } } }).catch(() => undefined);
      await prisma.aiUsageLog
        .deleteMany({ where: { workspaceId: { in: ALL } } })
        .catch(() => undefined);
      await prisma.workspace.deleteMany({ where: { id: { in: ALL } } }).catch(() => undefined);
    } finally {
      await closeTestApp(app);
    }
  });

  // ── The grace window ───────────────────────────────────────────────────────

  describe('an MCP workspace keeps first refusal, but only for a while', () => {
    it('leaves a fresh research job alone (explicit MCP)', async () => {
      const id = await job(wsMcp, { createdAt: INSIDE() });
      expect(await claim()).not.toContain(id);
    });

    it('TAKES the same job once the grace window has passed', async () => {
      const id = await job(wsMcp, { createdAt: OUTSIDE() });
      expect(await claim()).toContain(id);
    });

    /**
     * The boundary itself, not just the two sides of it. A window measured from
     * the wrong column, or in the wrong units, still passes the two cases above.
     */
    it('flips exactly at RESEARCH_MCP_GRACE_MS', async () => {
      const justInside = await job(wsMcp, {
        createdAt: new Date(Date.now() - RESEARCH_MCP_GRACE_MS + 30_000),
      });
      const justOutside = await job(wsMcp, {
        createdAt: new Date(Date.now() - RESEARCH_MCP_GRACE_MS - 30_000),
      });

      const taken = await claim();

      expect(taken).not.toContain(justInside);
      expect(taken).toContain(justOutside);
    });

    /**
     * The retry path. `runAt` is rewritten by the backoff, so a window measured
     * on it would push a failed takeover back inside first refusal and the job
     * would ping-pong forever instead of retrying.
     */
    it('does not hand a job back to MCP just because its runAt was pushed', async () => {
      const id = await job(wsMcp, { createdAt: OUTSIDE() });
      await prisma.scheduledJob.update({
        where: { id },
        data: { runAt: new Date(Date.now() - 1_000), attempts: 1 },
      });
      expect(await claim()).toContain(id);
    });
  });

  // ── AUTO ───────────────────────────────────────────────────────────────────

  describe('AUTO follows real MCP traffic', () => {
    it('reads as MCP — and holds the job — when a tool call happened recently', async () => {
      await mcpRun(wsAuto, new Date(Date.now() - 60_000));
      const id = await job(wsAuto, { createdAt: INSIDE() });

      expect(await claim()).not.toContain(id);
      expect(await lease.modeFor(wsAuto)).toBe('MCP');
    });

    it('reads as SERVER — and drains immediately — with no MCP traffic at all', async () => {
      const id = await job(wsAuto, { createdAt: INSIDE() });

      expect(await claim()).toContain(id);
      expect(await lease.modeFor(wsAuto)).toBe('SERVER');
    });

    it('reads as SERVER once the last tool call is older than the threshold', async () => {
      await mcpRun(wsAuto, new Date(Date.now() - MCP_CONNECTION_STALE_MS - 60_000));
      const id = await job(wsAuto, { createdAt: INSIDE() });

      expect(await claim()).toContain(id);
      expect(await lease.modeFor(wsAuto)).toBe('SERVER');
    });

    it('never counts a NON-MCP agent run as a connection', async () => {
      // The platform's own research opens `agent = 'research'` on every SERVER
      // night. Counting those would make every workspace we research look
      // "connected" and hand it a lane nobody is on.
      await prisma.agentRun.create({
        data: { workspaceId: wsAuto, agent: 'research', goal: `${SEED}-r`, startedAt: new Date() },
      });
      const id = await job(wsAuto, { createdAt: INSIDE() });

      expect(await claim()).toContain(id);
      expect(await lease.modeFor(wsAuto)).toBe('SERVER');
    });

    it('lets an explicit SERVER beat a live connection', async () => {
      await mcpRun(wsServer, new Date());
      const id = await job(wsServer, { createdAt: INSIDE() });

      expect(await claim()).toContain(id);
      expect(await lease.modeFor(wsServer)).toBe('SERVER');
    });

    it('lets an explicit MCP hold with no connection at all', async () => {
      const id = await job(wsMcp, { createdAt: INSIDE() });

      expect(await claim()).not.toContain(id);
      expect(await lease.modeFor(wsMcp)).toBe('MCP');
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  describe('tenant isolation — each workspaceId predicate fails its own assertion', () => {
    /**
     * The ONLY MCP traffic in the database belongs to the NEIGHBOUR. If the
     * `agent_runs` subquery lost its `workspaceId` correlation, `wsAuto` would
     * read as connected and its job would be held — so the assertion IS the
     * predicate, not a fixture that happens to agree with it.
     */
    it('does not let a neighbour MCP traffic hold THIS workspace job', async () => {
      await mcpRun(wsNeighbour, new Date());
      const mine = await job(wsAuto, { createdAt: INSIDE() });

      expect(await claim()).toContain(mine);
      expect(await lease.modeFor(wsAuto)).toBe('SERVER');
    });

    /**
     * The mirror image, so neither direction can be the accident. Same single
     * MCP run; this time it is the neighbour's OWN job that must be held.
     */
    it('does hold the neighbour own job on that same traffic', async () => {
      await mcpRun(wsNeighbour, new Date());
      const theirs = await job(wsNeighbour, { createdAt: INSIDE() });

      expect(await claim()).not.toContain(theirs);
      expect(await lease.modeFor(wsNeighbour)).toBe('MCP');
    });

    /**
     * And the workspace LANE itself: the only MCP-lane workspace with a job here
     * is the neighbour, so a `workspaces` subquery that lost its correlation
     * would hold the SERVER workspace's job too.
     */
    it('does not let a neighbour lane hold this workspace job', async () => {
      await mcpRun(wsNeighbour, new Date());
      const mine = await job(wsServer, { createdAt: INSIDE() });
      const theirs = await job(wsNeighbour, { createdAt: INSIDE() });

      const taken = await claim();

      expect(taken).toContain(mine);
      expect(taken).not.toContain(theirs);
    });

    it('scopes the takeover record to the workspace that was taken over', async () => {
      const mine = await job(wsAuto, { createdAt: OUTSIDE() });
      const theirs = await job(wsNeighbour, { createdAt: OUTSIDE() });

      await lease.recordPlatformTakeover(wsAuto, mine, new Date(Date.now() - 60_000));
      await prisma.scheduledJob.update({
        where: { id: mine },
        data: { status: 'DONE', completedAt: new Date() },
      });

      expect((await lease.recentPlatformTakeovers(wsAuto)).count).toBe(1);
      expect((await lease.recentPlatformTakeovers(wsNeighbour)).count).toBe(0);

      // ...and it could not have stamped the neighbour's row even by id.
      await lease.recordPlatformTakeover(wsNeighbour, mine, new Date());
      const row = await prisma.scheduledJob.findUnique({ where: { id: theirs } });
      expect((row?.payload as Record<string, unknown>)?.platformTookOver).toBeUndefined();
    });
  });

  // ── The two implementations of one rule ────────────────────────────────────

  /**
   * `claimBatch` (raw SQL) and `modeFor` (TypeScript) must never disagree. A
   * drift here is invisible in production: the SQL would hold a job the lease
   * service refuses to lease, and nothing would drain it at all.
   */
  describe('the SQL and the TypeScript agree on every combination', () => {
    const MATRIX: Array<{
      lane: string;
      traffic: 'fresh' | 'stale' | 'none';
      want: 'SERVER' | 'MCP';
    }> = [
      { lane: 'AUTO', traffic: 'fresh', want: 'MCP' },
      { lane: 'AUTO', traffic: 'stale', want: 'SERVER' },
      { lane: 'AUTO', traffic: 'none', want: 'SERVER' },
      { lane: 'MCP', traffic: 'fresh', want: 'MCP' },
      { lane: 'MCP', traffic: 'none', want: 'MCP' },
      { lane: 'SERVER', traffic: 'fresh', want: 'SERVER' },
      { lane: 'SERVER', traffic: 'none', want: 'SERVER' },
      // Values nothing in this codebase writes. Both sides must fail SAFE.
      { lane: 'nonsense', traffic: 'fresh', want: 'SERVER' },
      { lane: 'auto', traffic: 'fresh', want: 'SERVER' },
      { lane: 'mcp', traffic: 'fresh', want: 'SERVER' },
    ];

    it.each(MATRIX)('lane=$lane traffic=$traffic -> $want, in both', async (row) => {
      await setLane(wsAuto, row.lane);
      if (row.traffic === 'fresh') await mcpRun(wsAuto, new Date(Date.now() - 60_000));
      if (row.traffic === 'stale') {
        await mcpRun(wsAuto, new Date(Date.now() - MCP_CONNECTION_STALE_MS - 60_000));
      }

      const id = await job(wsAuto, { createdAt: INSIDE() });
      const sqlHeldIt = !(await claim()).includes(id);
      const tsSays = await lease.modeFor(wsAuto);

      expect({ sql: sqlHeldIt ? 'MCP' : 'SERVER', ts: tsSays }).toEqual({
        sql: row.want,
        ts: row.want,
      });
      // ...and the pure resolver both are meant to be an expression of.
      expect(effectiveResearchExecution(row.lane, row.traffic === 'fresh')).toBe(row.want);

      await setLane(wsAuto, 'AUTO');
    });
  });

  // ── No other kind may be touched ───────────────────────────────────────────

  /**
   * The whole exclusion hangs off `s."kind" = 'research.run'`. If that conjunct
   * ever slipped, an MCP workspace would stop getting its campaigns, its
   * follow-ups, its imports and its reminders — a far larger outage than the one
   * this predicate exists to create.
   */
  describe('every other job kind is untouched, in every lane', () => {
    const OTHER_KINDS = [
      'campaign.send',
      'sequence.step',
      'lead.import',
      'booking.reminder',
      'social.publish',
      'review.sync',
      'budget.reallocate',
      'workflow.step',
      'ads.pull',
      'iys.sync',
      'calendar.sync',
      'conversation.followup',
      'prospect.audit',
      'course.enroll',
      'invoice.issue',
      'contact.dedupe',
      'brand.analyze',
      'strategy.synthesize',
      'media.generate',
      'webhook.retry',
      'notification.digest',
      'lead.score',
      'sms.send',
      'email.send',
    ];

    it.each([wsAuto, wsMcp, wsServer])('claims all 24 other kinds for %s', async (workspaceId) => {
      await mcpRun(workspaceId, new Date()); // maximally "connected"
      const ids: string[] = [];
      for (const kind of OTHER_KINDS) {
        ids.push(await job(workspaceId, { kind, createdAt: INSIDE() }));
      }

      const taken = await claim();

      expect(ids.filter((id) => !taken.includes(id))).toEqual([]);
      await restore();
    });
  });

  // ── The takeover record ────────────────────────────────────────────────────

  describe('the takeover is recorded and read back', () => {
    it('stamps the job and reports it, with a real measured cost', async () => {
      const id = await job(wsAuto, { createdAt: OUTSIDE() });
      const since = new Date(Date.now() - 60_000);

      await prisma.aiUsageLog.create({
        data: {
          workspaceId: wsAuto,
          action: 'research.turn',
          model: 'claude-opus-4-8',
          inputTokens: 17_000,
          outputTokens: 330,
        },
      });

      await lease.recordPlatformTakeover(wsAuto, id, since);
      // The panel reads takeovers off COMPLETED jobs, as the runner leaves them.
      await prisma.scheduledJob.update({
        where: { id },
        data: { status: 'DONE', completedAt: new Date() },
      });

      const report = await lease.recentPlatformTakeovers(wsAuto);
      expect(report.count).toBe(1);
      expect(report.costUsd).toBeCloseTo(0.09325, 5);
      expect(report.costUnknown).toBe(0);
      expect(report.lastAt).toMatch(/^\d{4}-/);
    });

    it('does not count usage this workspace did not bill', async () => {
      const id = await job(wsAuto, { createdAt: OUTSIDE() });
      await prisma.aiUsageLog.create({
        data: {
          workspaceId: wsNeighbour,
          action: 'research.turn',
          model: 'claude-opus-4-8',
          inputTokens: 500_000,
          outputTokens: 50_000,
        },
      });

      await lease.recordPlatformTakeover(wsAuto, id, new Date(Date.now() - 60_000));

      const row = await prisma.scheduledJob.findUnique({ where: { id } });
      expect((row?.payload as Record<string, unknown>).platformTookOverUsd).toBe(0);
    });

    it('leaves the queue status carrying it, so the panel can say so', async () => {
      const id = await job(wsAuto, { createdAt: OUTSIDE() });
      await lease.recordPlatformTakeover(wsAuto, id, new Date(Date.now() - 60_000));
      await prisma.scheduledJob.update({
        where: { id },
        data: { status: 'DONE', completedAt: new Date() },
      });

      const status = await lease.queueStatus(wsAuto);
      expect(status.takenOver.count).toBe(1);
    });
  });
});
