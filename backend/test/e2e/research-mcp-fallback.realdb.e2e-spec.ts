import { randomUUID } from 'crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ResearchLeaseService } from '../../src/modules/marketing/research/research-lease.service';
import { ResearchRunnerService } from '../../src/modules/marketing/research/research-runner.service';
import {
  RESEARCH_MANUAL_KEY,
  RESEARCH_RUN_KIND,
} from '../../src/modules/marketing/research/research-kinds';
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
  let research: ResearchRunnerService;

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
    over: {
      kind?: string;
      createdAt?: Date;
      status?: string;
      payload?: Record<string, unknown>;
      dedupKey?: string;
    } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await prisma.scheduledJob.create({
      data: {
        id,
        workspaceId,
        kind: over.kind ?? RESEARCH_RUN_KIND,
        runAt: new Date(Date.now() - 60_000),
        payload: over.payload ?? { profileId: `${SEED}-p` },
        status: over.status ?? 'PENDING',
        dedupKey: over.dedupKey ?? null,
        createdAt: over.createdAt ?? INSIDE(),
      },
    });
    created.push(id);
    return id;
  };

  /** What `ResearchRunnerService.enqueueNow` writes: a job a human asked for. */
  const manual = (extra: Record<string, unknown> = {}) => ({
    profileId: `${SEED}-p`,
    [RESEARCH_MANUAL_KEY]: true,
    ...extra,
  });

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
    research = app.get(ResearchRunnerService);

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

  // ── "Run now" ──────────────────────────────────────────────────────────────

  /**
   * The button has to work in the lane the default now puts everyone in.
   *
   * `enqueueNow` stamps `RESEARCH_MANUAL_KEY` and the grace conjunct skips it,
   * so a manual run is claimable on the very next tick even while the nightly
   * rows beside it are still held. The pairing is the whole assertion: an
   * exemption that also released the nightly row would hand the model bill
   * straight back to the platform, and one that released neither is the
   * six-hour silence this fixes.
   */
  describe('a run a human asked for is never held', () => {
    it('claims a MANUAL job immediately on an explicit MCP workspace', async () => {
      const id = await job(wsMcp, { createdAt: INSIDE(), payload: manual() });
      expect(await claim()).toContain(id);
    });

    it('claims a MANUAL job immediately on an AUTO workspace with a live Claude', async () => {
      await mcpRun(wsAuto, new Date(Date.now() - 60_000));
      const id = await job(wsAuto, { createdAt: INSIDE(), payload: manual() });

      expect(await claim()).toContain(id);
      // ...and the LANE is genuinely MCP, so this is the exemption firing and
      // not the workspace having quietly resolved to SERVER.
      expect(await lease.modeFor(wsAuto)).toBe('MCP');
    });

    /**
     * THE PAIR. Both rows are in the same workspace, in the same lane, inside
     * the same grace window, and differ only by the payload flag.
     */
    it('takes the manual row and leaves the nightly row beside it held', async () => {
      await mcpRun(wsAuto, new Date(Date.now() - 60_000));
      const nightly = await job(wsAuto, { createdAt: INSIDE() });
      const pressed = await job(wsAuto, { createdAt: INSIDE(), payload: manual() });

      const taken = await claim();

      expect(taken).toContain(pressed);
      expect(taken).not.toContain(nightly);
    });

    /**
     * The flag is read as a STRING comparison, never a boolean cast: `payload`
     * is caller-supplied JSON and `NULL::boolean` on junk would throw inside
     * the claim and take the whole tick down — every kind, every workspace.
     * Anything that is not exactly `true` keeps first refusal, which is the
     * safe direction.
     */
    it.each([
      ['a string "true"', { profileId: 'p', [RESEARCH_MANUAL_KEY]: 'true' }],
      ['the number 1', { profileId: 'p', [RESEARCH_MANUAL_KEY]: 1 }],
      ['false', { profileId: 'p', [RESEARCH_MANUAL_KEY]: false }],
      ['null', { profileId: 'p', [RESEARCH_MANUAL_KEY]: null }],
      ['a nested object', { profileId: 'p', [RESEARCH_MANUAL_KEY]: { on: true } }],
      ['no payload keys at all', {}],
    ])('does not throw, and holds the row, for %s', async (_label, payload) => {
      const id = await job(wsMcp, {
        createdAt: INSIDE(),
        payload: payload as Record<string, unknown>,
      });
      const taken = await claim();
      // The string 'true' is the ONE non-boolean that legitimately reads as
      // manual: `->>` renders a JSON `true` to exactly that text, so a JSON
      // string "true" is indistinguishable from it and takes the same branch.
      if ((payload as Record<string, unknown>)[RESEARCH_MANUAL_KEY] === 'true') {
        expect(taken).toContain(id);
      } else {
        expect(taken).not.toContain(id);
      }
    });

    /**
     * THE SECOND-ORDER EFFECT, end to end through the real `enqueueNow`.
     *
     * `ScheduledJobService.schedule` dedups on `(kind, dedupKey)` WHERE
     * `status = 'PENDING'` and does NOT reset `createdAt`. So a "Run now"
     * pressed while tonight's held nightly row is still queued does not create
     * a row of its own — it UPDATES that one, inheriting its six-hour-old
     * clock. That is exactly the collapse that would have swallowed a
     * distinct-`kind` fix's benefit, and with a payload flag it goes the other
     * way: the stamp lands on the held row and PROMOTES it.
     *
     * Asserted on both halves — same row id (no duplicate paid run) AND
     * claimable now (the press was honoured) — because either alone would pass
     * for the wrong reason.
     */
    it('promotes the held nightly row when Run now collapses onto it', async () => {
      const profileId = `${SEED}-collapse`;
      await mcpRun(wsAuto, new Date(Date.now() - 60_000));
      const nightly = await job(wsAuto, {
        createdAt: INSIDE(),
        payload: { profileId },
        dedupKey: `research:${profileId}`,
      });

      // Held, as the nightly lane should be.
      expect(await claim()).not.toContain(nightly);
      await restore();

      // The real "Run now" path, not a hand-written row.
      await research.enqueueNow(wsAuto, profileId);

      const rows = await prisma.scheduledJob.findMany({
        where: { workspaceId: wsAuto, dedupKey: `research:${profileId}` },
        select: { id: true, createdAt: true, payload: true },
      });
      // ONE row. A second kind would have made two, and the profile would have
      // been researched — and paid for — twice.
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(nightly);
      // The inherited clock is still there; the flag is what overrides it.
      expect(rows[0].createdAt.getTime()).toBeLessThan(Date.now() - 60_000);
      expect((rows[0].payload as Record<string, unknown>)[RESEARCH_MANUAL_KEY]).toBe(true);

      expect(await claim()).toContain(nightly);
    });

    /** A SERVER workspace was never held, so the flag changes nothing there. */
    it('changes nothing on a SERVER workspace', async () => {
      const plain = await job(wsServer, { createdAt: INSIDE() });
      const pressed = await job(wsServer, { createdAt: INSIDE(), payload: manual() });

      const taken = await claim();

      expect(taken).toContain(plain);
      expect(taken).toContain(pressed);
    });

    /**
     * Tenant boundary, same shape as every other case here: the neighbour's
     * manual row must not release THIS workspace's held nightly row.
     */
    it('does not let a neighbour manual run release this workspace held job', async () => {
      await mcpRun(wsAuto, new Date(Date.now() - 60_000));
      await mcpRun(wsNeighbour, new Date(Date.now() - 60_000));
      const mine = await job(wsAuto, { createdAt: INSIDE() });
      const theirs = await job(wsNeighbour, { createdAt: INSIDE(), payload: manual() });

      const taken = await claim();

      expect(taken).toContain(theirs);
      expect(taken).not.toContain(mine);
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
