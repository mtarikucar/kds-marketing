import { randomUUID } from 'crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  ResearchLeaseService,
  RESEARCH_JOB_CLAIMED,
  RESEARCH_LEASE_MS,
} from '../../src/modules/marketing/research/research-lease.service';
import { RESEARCH_RUN_KIND } from '../../src/modules/marketing/research/research-kinds';
import { ScheduledJobRunnerService } from '../../src/modules/marketing/scheduling/scheduled-job-runner.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The MCP research lane against REAL Postgres.
 *
 * Three things only real SQL can settle here, and each of them is money.
 *
 * 1. **The claim is atomic or the workspace pays twice.** A research run is a
 *    long Claude session on the owner's own subscription plus live
 *    Apify/Firecrawl calls on Jeeta's vendor keys. The lease is one conditional
 *    `UPDATE ... WHERE status = 'PENDING'`, and it is safe only because
 *    Postgres re-evaluates that predicate against the COMMITTED row version
 *    after blocking on the row lock. A mocked Prisma accepts any `where` it is
 *    handed and will happily report two winners — the unit spec can prove the
 *    predicate is present, and nothing else.
 *
 * 2. **The server runner's exclusion is raw SQL.** `claimBatch` grew a
 *    `NOT (kind = ... AND EXISTS (SELECT 1 FROM workspaces ...))` clause, inside
 *    a `FOR UPDATE SKIP LOCKED` subquery. Whether that is even valid Postgres —
 *    let alone whether it excludes the right rows and no others — is not a
 *    question a jest mock can answer.
 *
 * 3. **The tenant boundary is hand-written on every predicate.** `scheduled_jobs`
 *    carries a bare `workspaceId String` with no foreign key, so a neighbour's
 *    job id is a perfectly legal thing to pass. Every fixture below is
 *    cross-stamped: the foreign workspace has its OWN queued job and its own
 *    active profile and is itself in MCP mode, so a missing `workspaceId`
 *    predicate produces the WRONG job rather than no job — a doubly-guarded
 *    fixture would have let three of these pass with the predicate deleted.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Research MCP lease — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let lease: ResearchLeaseService;
  let runner: ScheduledJobRunnerService;

  const SEED = `mcplease-${randomUUID().slice(0, 8)}`;

  const wsA = randomUUID(); // MCP mode — the workspace under test
  const wsB = randomUUID(); // MCP mode — the NEIGHBOUR, fully equipped
  const wsServer = randomUUID(); // SERVER mode — the platform still drains it
  const packageId = randomUUID();

  const profileA = randomUUID();
  const profileB = randomUUID();
  const profileServer = randomUUID();

  /** Every job id this spec creates, for teardown. */
  const created: string[] = [];

  const job = async (
    workspaceId: string,
    profileId: string,
    over: { status?: string; kind?: string; createdAt?: Date; lockedAt?: Date | null } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await prisma.scheduledJob.create({
      data: {
        id,
        workspaceId,
        kind: over.kind ?? RESEARCH_RUN_KIND,
        runAt: new Date(Date.now() - 60_000),
        payload: { profileId },
        status: over.status ?? 'PENDING',
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
        ...(over.lockedAt !== undefined ? { lockedAt: over.lockedAt } : {}),
      },
    });
    created.push(id);
    return id;
  };

  const statusOf = async (id: string): Promise<string> =>
    (await prisma.scheduledJob.findUnique({ where: { id }, select: { status: true } }))!.status;

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    ({ app, prisma } = await createRealDbTestApp());
    lease = app.get(ResearchLeaseService);
    runner = app.get(ScheduledJobRunnerService);

    // Silence every cron for the duration. The scheduled-job runner fires once
    // a minute and would claim and DISPATCH the fixtures below mid-assertion —
    // `claimBatch` is called directly here precisely so the SQL is what is
    // under test, not a race with the live scheduler.
    const scheduler = app.get(SchedulerRegistry);
    for (const [, cron] of scheduler.getCronJobs()) {
      try {
        (cron as { stop?: () => void }).stop?.();
      } catch {
        /* a cron that will not stop is not this spec's problem to fix */
      }
    }

    await prisma.workspace.createMany({
      data: [
        { id: wsA, slug: `${SEED}-a`, name: 'Lease A', productName: 'Lease A', researchExecution: 'MCP' },
        { id: wsB, slug: `${SEED}-b`, name: 'Lease B', productName: 'Lease B', researchExecution: 'MCP' },
        {
          id: wsServer,
          slug: `${SEED}-s`,
          name: 'Lease S',
          productName: 'Lease S',
          researchExecution: 'SERVER',
        },
      ] as never,
    });

    // A real plan, because `buildJob` refuses a workspace with no daily lead
    // allowance left — and a workspace with no subscription has none.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Lease Plan',
        dailyLeadQuota: -1,
        maxUsers: 10,
        maxResearchProfiles: 5,
        features: { research: true },
        priceMonthlyTRY: 1,
        priceMonthlyUSD: 1,
      },
    });
    await prisma.workspaceSubscription.createMany({
      data: [wsA, wsB, wsServer].map((workspaceId) => ({
        workspaceId,
        packageId,
        status: 'ACTIVE',
        currency: 'TRY',
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })),
    });

    await prisma.researchProfile.createMany({
      data: [
        {
          id: profileA,
          workspaceId: wsA,
          name: `${SEED}-a`,
          icpDescription: 'Independent salons in Izmir that still take bookings on paper.',
          geo: { country: 'TR', cities: ['Izmir'] },
          language: 'tr',
        },
        {
          id: profileB,
          workspaceId: wsB,
          name: `${SEED}-b`,
          icpDescription: 'Independent cafes in Ankara with poor delivery reviews.',
          geo: { country: 'TR', cities: ['Ankara'] },
          language: 'tr',
        },
        {
          id: profileServer,
          workspaceId: wsServer,
          name: `${SEED}-s`,
          icpDescription: 'Independent bakeries in Bursa with no online ordering at all.',
          geo: { country: 'TR', cities: ['Bursa'] },
          language: 'tr',
        },
      ],
    });
  });

  afterEach(async () => {
    if (!realDbEnabled() || !prisma) return;
    await prisma.scheduledJob.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    created.length = 0;
    await prisma.agentRun
      .deleteMany({ where: { workspaceId: { in: [wsA, wsB, wsServer] } } })
      .catch(() => undefined);
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    const scope = { in: [wsA, wsB, wsServer] };
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      if (!prisma) return;
      await del(() => prisma.scheduledJob.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.researchCandidate.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.toolCallLog.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.agentRun.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.researchProfile.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.usageCounter.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.workspaceSubscription.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.package.deleteMany({ where: { id: packageId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: scope } }));
    } finally {
      await closeTestApp(app);
    }
  });

  describe('the lease is atomic', () => {
    it('gives ONE job to exactly ONE of two simultaneous claimers', async () => {
      // The double-bill. Both callers read the same PENDING row, both issue the
      // conditional UPDATE; the second blocks on the row lock, re-reads the
      // committed version, sees CLAIMED and matches zero rows.
      const jobId = await job(wsA, profileA);

      const [first, second] = await Promise.all([lease.claim(wsA), lease.claim(wsA)]);

      const winners = [first, second].filter((r) => r.job !== null);
      const losers = [first, second].filter((r) => r.job === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0].job!.jobId).toBe(jobId);
      expect(losers[0].reason).toBe('queue-empty');
      expect(await statusOf(jobId)).toBe(RESEARCH_JOB_CLAIMED);
    });

    it('gives two jobs to two claimers, one each — never the same one twice', async () => {
      const one = await job(wsA, profileA);
      const two = await job(wsA, profileA);

      const results = await Promise.all([lease.claim(wsA), lease.claim(wsA)]);
      const ids = results.map((r) => r.job?.jobId).filter(Boolean);

      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      expect(new Set(ids)).toEqual(new Set([one, two]));
    });

    it('hands back the full server-authored brief, not just an id', async () => {
      await job(wsA, profileA);

      const { job: claimed } = await lease.claim(wsA);

      expect(claimed!.instruction).toContain('HARD DISQUALIFIERS');
      expect(claimed!.instruction).toContain('still take bookings on paper');
      expect(claimed!.instruction).toContain('Izmir');
      expect(claimed!.instruction).toContain('jeeta.submit_research_candidates');
      expect(claimed!.agentRunId).toBeTruthy();
      const run = await prisma.agentRun.findUnique({ where: { id: claimed!.agentRunId } });
      expect(run).toMatchObject({ workspaceId: wsA, agent: 'research.mcp' });
    });
  });

  describe('the lease expires', () => {
    it('returns an abandoned job to the queue and lets it be claimed again', async () => {
      // A crashed client must not hold a night hostage.
      const jobId = await job(wsA, profileA, {
        status: RESEARCH_JOB_CLAIMED,
        lockedAt: new Date(Date.now() - RESEARCH_LEASE_MS - 60_000),
      });

      const { job: claimed } = await lease.claim(wsA);

      expect(claimed!.jobId).toBe(jobId);
      expect(await statusOf(jobId)).toBe(RESEARCH_JOB_CLAIMED);
    });

    it('does NOT steal a lease that is still live', async () => {
      const jobId = await job(wsA, profileA, {
        status: RESEARCH_JOB_CLAIMED,
        lockedAt: new Date(),
      });

      const res = await lease.claim(wsA);

      expect(res.job).toBeNull();
      expect(res.reason).toBe('queue-empty');
      expect(await statusOf(jobId)).toBe(RESEARCH_JOB_CLAIMED);
    });
  });

  describe('tenant isolation — every predicate cross-stamped', () => {
    it('never leases a NEIGHBOUR job, even when its own queue is empty', async () => {
      // wsB is in MCP mode with an active profile and a live plan: the ONLY
      // thing between it and this job is the workspaceId predicate.
      const foreign = await job(wsA, profileA);

      const res = await lease.claim(wsB);

      expect(res.job).toBeNull();
      expect(res.reason).toBe('queue-empty');
      expect(await statusOf(foreign)).toBe('PENDING');
    });

    it('leases its OWN job when both workspaces have one queued', async () => {
      const mine = await job(wsB, profileB);
      const theirs = await job(wsA, profileA);

      const res = await lease.claim(wsB);

      expect(res.job!.jobId).toBe(mine);
      expect(res.job!.profileId).toBe(profileB);
      expect(await statusOf(theirs)).toBe('PENDING');
    });

    it('cannot SUBMIT into a neighbour claimed job', async () => {
      const foreign = await job(wsA, profileA);
      await lease.claim(wsA);

      await expect(
        lease.submit(wsB, foreign, [
          {
            externalRef: 'phone:+905551112233',
            businessName: 'Leak',
            businessType: 'CAFE',
            painPoint: 'p',
            evidence: 'e',
            pitch: 'q',
          },
        ]),
      ).rejects.toThrow(/no claimed research job/i);

      expect(await prisma.researchCandidate.count({ where: { workspaceId: wsB } })).toBe(0);
      expect(await prisma.researchCandidate.count({ where: { workspaceId: wsA } })).toBe(0);
    });

    it('cannot COMPLETE a neighbour claimed job', async () => {
      const foreign = await job(wsA, profileA);
      await lease.claim(wsA);

      await expect(lease.complete(wsB, foreign, { status: 'DONE' })).rejects.toThrow(
        /no claimed research job/i,
      );
      expect(await statusOf(foreign)).toBe(RESEARCH_JOB_CLAIMED);
    });

    it('cannot take a tool context on a neighbour claimed job', async () => {
      // This is what an Apify call is metered and logged against.
      const foreign = await job(wsA, profileA);
      await lease.claim(wsA);

      await expect(lease.toolContext(wsB, foreign)).rejects.toThrow(/no claimed research job/i);
    });

    it('is not starved by a neighbour with a long queue', async () => {
      // The predicate this test exists for is the `workspaceId` on the queue
      // LOOKUP, not the one on the conditional update. Removing the lookup's
      // leaves the boundary intact — the update still refuses — so every
      // assertion above stays green while the claim quietly walks a neighbour's
      // rows instead of its own. Bounded at MAX_CLAIM_ATTEMPTS, that is a
      // cross-tenant denial of service: a busy neighbour means this workspace's
      // own job is never reached, and its research silently stops.
      //
      // Six neighbour jobs, all older, so an unscoped lookup exhausts the
      // attempt budget before it ever sees ours.
      const older = new Date(Date.now() - 10 * 60_000);
      for (let i = 0; i < 6; i++) {
        const id = randomUUID();
        await prisma.scheduledJob.create({
          data: {
            id,
            workspaceId: wsA,
            kind: RESEARCH_RUN_KIND,
            runAt: older,
            payload: { profileId: profileA },
            status: 'PENDING',
          },
        });
        created.push(id);
      }
      const mine = await job(wsB, profileB);

      const res = await lease.claim(wsB);

      expect(res.job).not.toBeNull();
      expect(res.job!.jobId).toBe(mine);
    });

    it('counts only its OWN queue', async () => {
      await job(wsA, profileA);
      await job(wsA, profileA);
      await job(wsB, profileB);

      expect((await lease.queueStatus(wsA)).pending).toBe(2);
      expect((await lease.queueStatus(wsB)).pending).toBe(1);
    });
  });

  describe('the round trip', () => {
    it('stages candidates against the claimed job profile and closes the job', async () => {
      const jobId = await job(wsA, profileA);
      const { job: claimed } = await lease.claim(wsA);

      const res = await lease.submit(wsA, jobId, [
        {
          externalRef: `domain:${SEED}-one.test`,
          businessName: 'Salon One',
          businessType: 'SALON',
          painPoint: 'Randevu kaosu',
          evidence: 'google review',
          pitch: 'merhaba',
        },
        // Malformed — dropped by the SHARED validator, not by a second copy.
        { businessName: 'No ref at all' },
      ]);

      expect(res).toMatchObject({ researched: 1, staged: 1, duplicates: 0 });
      const staged = await prisma.researchCandidate.findMany({ where: { workspaceId: wsA } });
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        profileId: profileA,
        businessName: 'Salon One',
        agentRunId: claimed!.agentRunId,
        status: 'PENDING',
      });

      const closed = await lease.complete(wsA, jobId, { status: 'DONE' });
      expect(closed.closed).toBe(true);
      expect(await statusOf(jobId)).toBe('DONE');

      await prisma.researchCandidate.deleteMany({ where: { workspaceId: wsA } });
    });

    it('records the reason a job failed, so the queue is not a mystery', async () => {
      const jobId = await job(wsA, profileA);
      await lease.claim(wsA);

      await lease.complete(wsA, jobId, { status: 'FAILED', reason: 'no places in this geo' });

      const row = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
      expect(row).toMatchObject({ status: 'FAILED' });
      expect(row!.lastError).toContain('no places in this geo');
    });
  });

  describe('the server runner stays off an MCP workspace research queue', () => {
    it('skips MCP research jobs while claiming everything else', async () => {
      const mcpResearch = await job(wsA, profileA);
      const mcpOther = await job(wsA, profileA, { kind: 'conversation.followup' });
      const serverResearch = await job(wsServer, profileServer);

      // The private claim SQL directly: `tick()` would also DISPATCH, and what
      // is under test is which rows the UPDATE takes.
      const claimed: Array<{ id: string }> = await (
        runner as unknown as { claimBatch: () => Promise<Array<{ id: string }>> }
      ).claimBatch();
      const ids = claimed.map((c) => c.id);

      // The whole feature, in one assertion: the platform leaves this row for
      // the owner's Claude.
      expect(ids).not.toContain(mcpResearch);
      expect(await statusOf(mcpResearch)).toBe('PENDING');

      // And the exclusion is narrow — an MCP-research workspace still gets its
      // follow-ups, campaigns and imports drained, and a SERVER workspace's
      // research is untouched by any of this.
      expect(ids).toContain(mcpOther);
      expect(ids).toContain(serverResearch);
    });

    it('starts draining again the moment the workspace hands research back', async () => {
      // The reason the mode is read live rather than stamped on the row: a
      // stamped job would be orphaned forever here, drained by nobody.
      const jobId = await job(wsA, profileA);
      await prisma.workspace.update({ where: { id: wsA }, data: { researchExecution: 'SERVER' } });
      try {
        const claimed: Array<{ id: string }> = await (
          runner as unknown as { claimBatch: () => Promise<Array<{ id: string }>> }
        ).claimBatch();
        expect(claimed.map((c) => c.id)).toContain(jobId);
      } finally {
        await prisma.workspace.update({ where: { id: wsA }, data: { researchExecution: 'MCP' } });
      }
    });

    it('refuses to lease for a workspace the platform is still draining', async () => {
      await job(wsServer, profileServer);

      const res = await lease.claim(wsServer);

      expect(res.job).toBeNull();
      expect(res.reason).toBe('not-in-mcp-mode');
    });
  });
});
