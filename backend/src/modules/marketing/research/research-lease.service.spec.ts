import 'reflect-metadata';
import {
  ResearchLeaseService,
  RESEARCH_JOB_CLAIMED,
  RESEARCH_LEASE_MS,
} from './research-lease.service';
import { RESEARCH_RUN_KIND } from './research-kinds';
import { ResearchJob } from './research-job.service';

const WS = 'ws-a';
const FOREIGN = 'ws-b';

const JOB: ResearchJob = {
  workspaceId: WS,
  workspaceSlug: 'acme',
  productName: 'Jeeta',
  productUrl: null,
  productDescription: 'CRM for salons',
  defaultLanguage: 'tr',
  profile: {
    id: 'p1',
    name: 'Salons İzmir',
    icpDescription: 'Busy salons with poor booking',
    productPitch: null,
    geo: { country: 'TR', cities: ['İzmir'] },
    language: 'tr',
    businessTypes: ['SALON'],
    exclusions: 'zincirler',
    lastRunAt: null,
  },
  remainingToday: 20,
  maxBatchSize: 50,
};

const ROW = {
  id: 'job-1',
  workspaceId: WS,
  kind: RESEARCH_RUN_KIND,
  payload: { profileId: 'p1' },
  status: 'PENDING',
  createdAt: new Date('2026-08-28T03:00:00Z'),
  runAt: new Date('2026-08-28T03:00:00Z'),
};

function build(
  over: {
    mode?: string;
    /** Rows in `scheduled_jobs`, in the order the PENDING lookup should see them. */
    rows?: Array<Record<string, unknown>>;
    /** How many times the PENDING->CLAIMED flip loses the race before winning. */
    loseRaces?: number;
    builtJob?: ResearchJob | null;
  } = {},
) {
  // A tiny in-memory `scheduled_jobs` that actually APPLIES the predicates,
  // rather than a stub keyed on the shape of the call.
  //
  // The first version of this fixture answered the foreign-workspace cases with
  // a hardcoded `null`, so deleting `workspaceId` from the service's where
  // clause left them green — the fixture was guarding the boundary the test
  // claimed to prove. Every isolation assertion below now fails on its own when
  // its predicate is removed, because the row really is there and really is
  // stamped with somebody else's workspace.
  const table: Array<Record<string, unknown>> = (
    over.rows ?? [{ ...ROW, status: RESEARCH_JOB_CLAIMED, payload: { profileId: 'p1', mcpAgentRunId: 'run-1' } }]
  ).map((r) => ({ ...r }));
  let racesToLose = over.loseRaces ?? 0;

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'id' && typeof v === 'object' && v !== null && 'notIn' in (v as object)) {
        if ((v as { notIn: string[] }).notIn.includes(row.id as string)) return false;
        continue;
      }
      // Range operators are not modelled; the specs that care about them assert
      // on the recorded arguments instead.
      if (typeof v === 'object' && v !== null && !(v instanceof Date)) continue;
      if (row[k] !== v) return false;
    }
    return true;
  };

  const findFirst = jest.fn(async (args: { where: Record<string, unknown> }) => {
    const hit = table.find((r) => matches(r, args.where));
    return hit ? { ...hit } : null;
  });

  const updateMany = jest.fn(
    async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const isClaimFlip =
        args.where.status === 'PENDING' && args.data.status === RESEARCH_JOB_CLAIMED;
      if (isClaimFlip && racesToLose > 0) {
        // Somebody else flipped this row between our read and our write.
        racesToLose -= 1;
        return { count: 0 };
      }
      const hits = table.filter((r) => matches(r, args.where));
      for (const r of hits) Object.assign(r, args.data);
      return { count: hits.length };
    },
  );

  const prisma = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ researchExecution: over.mode ?? 'MCP' }),
    },
    scheduledJob: {
      findFirst,
      updateMany,
      count: jest.fn().mockResolvedValue(0),
    },
    approvalRequest: { count: jest.fn().mockResolvedValue(0) },
  };
  const jobs = {
    buildJob: jest.fn().mockResolvedValue(over.builtJob === undefined ? JOB : over.builtJob),
  };
  const finalize = {
    finalize: jest.fn().mockResolvedValue({ researched: 2, staged: 2, duplicates: 0 }),
  };
  const runs = {
    start: jest.fn().mockResolvedValue('run-1'),
    finish: jest.fn().mockResolvedValue(undefined),
  };
  const brandContext = { summaryFor: jest.fn().mockResolvedValue(null) };
  const svc = new ResearchLeaseService(
    prisma as never,
    jobs as never,
    finalize as never,
    runs as never,
    brandContext as never,
  );
  return { svc, prisma, jobs, finalize, runs, brandContext, updateMany, findFirst, table };
}

/**
 * The MCP research lane's lease.
 *
 * This is the part that costs real money if it is wrong. A research run is a
 * long Claude session plus live Apify/Firecrawl calls; two clients holding the
 * same job means the reasoning is paid for twice on the owner's subscription
 * and the crawl twice on Jeeta's vendor keys, for one night's leads.
 */
describe('ResearchLeaseService — claiming', () => {
  it('refuses to lease anything for a SERVER-mode workspace', async () => {
    // The mode is not decoration: a SERVER workspace's jobs are being drained
    // by the platform's own worker, and handing one to an MCP client too would
    // run the same night twice.
    const { svc, updateMany } = build({ mode: 'SERVER' });

    const res = await svc.claim(WS);

    expect(res.job).toBeNull();
    expect(res.reason).toBe('not-in-mcp-mode');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('treats any unexpected mode value as SERVER', async () => {
    const { svc } = build({ mode: 'mcp' }); // lowercase is not the mode
    expect((await svc.claim(WS)).reason).toBe('not-in-mcp-mode');
  });

  it('flips PENDING → CLAIMED atomically, guarded on BOTH status and workspace', async () => {
    // The whole race lives in this one predicate. Postgres re-evaluates a
    // conditional UPDATE against the committed row version, so the second
    // caller matches zero rows — but only while `status: 'PENDING'` is in the
    // where clause.
    const { svc, updateMany } = build();

    await svc.claim(WS);

    const claimCall = updateMany.mock.calls.find((c) => (c[0] as any).where.id !== undefined)!;
    expect((claimCall[0] as any).where).toEqual({
      id: 'job-1',
      workspaceId: WS,
      status: 'PENDING',
    });
    expect((claimCall[0] as any).data.status).toBe(RESEARCH_JOB_CLAIMED);
    expect((claimCall[0] as any).data.lockedAt).toBeInstanceOf(Date);
  });

  it('returns nothing when it LOSES the race and no other job is queued', async () => {
    // count 0 from the conditional update means somebody else already flipped
    // the row. The loser must come back empty, not retry the same row.
    const { svc } = build({ rows: [{ ...ROW }], loseRaces: 1 });

    const res = await svc.claim(WS);

    expect(res.job).toBeNull();
    expect(res.reason).toBe('queue-empty');
  });

  it('moves on to the NEXT job when it loses the race on the first', async () => {
    const second = { ...ROW, id: 'job-2', payload: { profileId: 'p2' } };
    const { svc, findFirst } = build({ rows: [{ ...ROW }, second], loseRaces: 1 });

    const res = await svc.claim(WS);

    expect(res.job!.jobId).toBe('job-2');
    // The lost row is excluded from the next lookup rather than re-picked.
    const secondLookup = findFirst.mock.calls.find(
      (c) => (c[0] as any).where.status === 'PENDING' && (c[0] as any).where.id,
    )!;
    expect((secondLookup[0] as any).where.id).toEqual({ notIn: ['job-1'] });
  });

  it('scopes every queue read to the caller workspace and the research kind', async () => {
    const { svc, findFirst } = build();

    await svc.claim(WS);

    const lookup = findFirst.mock.calls[0][0] as any;
    expect(lookup.where.workspaceId).toBe(WS);
    expect(lookup.where.kind).toBe(RESEARCH_RUN_KIND);
    expect(lookup.where.status).toBe('PENDING');
  });

  it('releases a lease that has run out before looking for work', async () => {
    // A crashed client must not hold a job forever. The sweep is lazy — done
    // on the way in — so there is no second cron to forget about.
    const { svc, updateMany } = build();

    await svc.claim(WS);

    const sweep = updateMany.mock.calls.find((c) => (c[0] as any).where.id === undefined)!;
    const where = (sweep[0] as any).where;
    expect(where.workspaceId).toBe(WS);
    expect(where.kind).toBe(RESEARCH_RUN_KIND);
    expect(where.status).toBe(RESEARCH_JOB_CLAIMED);
    expect(where.lockedAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - (where.lockedAt.lt as Date).getTime()).toBeGreaterThanOrEqual(RESEARCH_LEASE_MS - 5_000);
    expect((sweep[0] as any).data).toEqual({ status: 'PENDING', lockedAt: null });
  });

  it('hands back the WHOLE server-authored instruction, not a job id', async () => {
    // Quality must not depend on the sentence the owner typed into their
    // scheduled task months ago. Everything that decides what a good candidate
    // is travels with the job.
    const { svc } = build();

    const { job } = await svc.claim(WS);

    expect(job!.jobId).toBe('job-1');
    expect(job!.profileId).toBe('p1');
    expect(job!.agentRunId).toBe('run-1');
    expect(job!.instruction).toContain('HARD DISQUALIFIERS');
    expect(job!.instruction).toContain('Busy salons with poor booking');
    expect(job!.instruction).toContain('GEO (hard filter)');
    expect(job!.instruction).toContain('EXCLUSIONS (hard filter): zincirler');
    expect(job!.instruction).toContain('LANGUAGE for painPoint/evidence/pitch: tr');
    // And it must name the tools that close the loop, or the job is leased and
    // never returned.
    expect(job!.instruction).toContain('jeeta.submit_research_candidates');
    expect(job!.instruction).toContain('jeeta.complete_research_job');
    expect(job!.targetVolume).toBe(20);
  });

  it('opens an AgentRun so the owner-side work is auditable like any other', async () => {
    const { svc, runs } = build();

    await svc.claim(WS);

    expect(runs.start).toHaveBeenCalledWith(WS, expect.objectContaining({ agent: 'research.mcp' }));
  });

  it('closes a job whose profile is paused or out of quota, and tries the next', async () => {
    // buildJob is the ONLY place the daily lead allowance and the profile
    // status are read. A null from it means this job cannot produce anything,
    // and leaving it PENDING would hand it out again on every poll forever.
    const second = { ...ROW, id: 'job-2' };
    const { svc, jobs, updateMany } = build({ rows: [{ ...ROW }, second] });
    jobs.buildJob.mockResolvedValueOnce(null).mockResolvedValueOnce(JOB);

    const res = await svc.claim(WS);

    expect(res.job!.jobId).toBe('job-2');
    const closes = updateMany.mock.calls.filter((c) => (c[0] as any).data?.status === 'DONE');
    expect(closes).toHaveLength(1);
    expect((closes[0][0] as any).where).toMatchObject({ id: 'job-1', workspaceId: WS });
    expect((closes[0][0] as any).data.lastError).toMatch(/paused|quota|allowance/i);
  });
});

describe('ResearchLeaseService — submitting', () => {
  it('stages through the SHARED finalize path, under the claimed job profile', async () => {
    const { svc, finalize } = build();

    const res = await svc.submit(WS, 'job-1', [{ businessName: 'X' }]);

    expect(finalize.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, profile: expect.objectContaining({ id: 'p1' }) }),
      'run-1',
      [{ businessName: 'X' }],
    );
    expect(res).toMatchObject({ staged: 2, duplicates: 0, researched: 2 });
  });

  it('refuses LOUDLY for a job in another workspace', async () => {
    // The predicate that must fail its own assertion. A silent "0 staged"
    // here would read to a model as "nothing qualified" — the exact failure
    // shape this feature exists to stop.
    const { svc, prisma, finalize } = build();

    // The row EXISTS and is CLAIMED — it just belongs to ws-a.
    await expect(svc.submit(FOREIGN, 'job-1', [{}])).rejects.toThrow(/no claimed research job/i);

    expect((prisma.scheduledJob.findFirst.mock.calls[0][0] as any).where).toMatchObject({
      id: 'job-1',
      workspaceId: FOREIGN,
      kind: RESEARCH_RUN_KIND,
      status: RESEARCH_JOB_CLAIMED,
    });
    expect(finalize.finalize).not.toHaveBeenCalled();
  });

  it('refuses when the lease already expired back to PENDING, and says so', async () => {
    // The lease ran out and the sweep put the row back in the queue.
    const { svc } = build({ rows: [{ ...ROW, status: 'PENDING' }] });
    await expect(svc.submit(WS, 'job-1', [{}])).rejects.toThrow(/expired|claim/i);
  });
});

describe('ResearchLeaseService — completing', () => {
  it('closes a claimed job DONE and finishes its AgentRun', async () => {
    const { svc, updateMany, runs } = build();

    const res = await svc.complete(WS, 'job-1', { status: 'DONE' });

    expect(res.closed).toBe(true);
    const call = updateMany.mock.calls.find((c) => (c[0] as any).data?.status === 'DONE')!;
    expect((call[0] as any).where).toEqual({
      id: 'job-1',
      workspaceId: WS,
      status: RESEARCH_JOB_CLAIMED,
    });
    expect(runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'DONE' }));
  });

  it('records the reason on a FAILED close so the queue is not a mystery', async () => {
    const { svc, updateMany, runs } = build();

    await svc.complete(WS, 'job-1', { status: 'FAILED', reason: 'apify returned nothing' });

    const call = updateMany.mock.calls.find((c) => (c[0] as any).data?.status === 'FAILED')!;
    expect((call[0] as any).data.lastError).toContain('apify returned nothing');
    expect(runs.finish).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('apify') }),
    );
  });

  it('cannot close another workspace job', async () => {
    const { svc, updateMany } = build();

    await expect(svc.complete(FOREIGN, 'job-1', { status: 'DONE' })).rejects.toThrow(
      /no claimed research job/i,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('ResearchLeaseService — queue status', () => {
  it('counts the un-drained queue and the age of its oldest job', async () => {
    const { svc, prisma } = build();
    prisma.scheduledJob.count
      .mockResolvedValueOnce(4) // pending
      .mockResolvedValueOnce(1); // claimed
    prisma.scheduledJob.findFirst.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    prisma.approvalRequest.count.mockResolvedValue(2);

    const s = await svc.queueStatus(WS);

    expect(s).toMatchObject({ mode: 'MCP', pending: 4, claimed: 1, pendingApprovals: 2 });
    expect(s.oldestPendingAgeHours).toBeGreaterThanOrEqual(71);
    expect(s.oldestPendingAt).toMatch(/^\d{4}-/);
  });

  it('reports an empty queue as empty, with no age at all', async () => {
    const { svc, prisma } = build();
    prisma.scheduledJob.findFirst.mockResolvedValueOnce(null);

    const s = await svc.queueStatus(WS);

    expect(s).toMatchObject({ pending: 0, claimed: 0, oldestPendingAt: null, oldestPendingAgeHours: null });
  });

  it('scopes every count to the caller workspace and the research kind', async () => {
    const { svc, prisma } = build();

    await svc.queueStatus(WS);

    for (const call of prisma.scheduledJob.count.mock.calls) {
      expect((call[0] as any).where).toMatchObject({ workspaceId: WS, kind: RESEARCH_RUN_KIND });
    }
    expect((prisma.approvalRequest.count.mock.calls[0][0] as any).where.workspaceId).toBe(WS);
  });
});

describe('ResearchLeaseService — tool context', () => {
  it('resolves the run id and profile geo from the CLAIMED job, never from the caller', async () => {
    // The data tools bill Apify/Firecrawl and log a ToolCallLog. If the caller
    // supplied the run id or the geo, an agent could meter its spend onto
    // another run or search outside the profile's hard geo filter.
    const { svc } = build();

    const ctx = await svc.toolContext(WS, 'job-1');

    expect(ctx).toMatchObject({ workspaceId: WS, runId: 'run-1' });
    expect(ctx.geo).toEqual({ country: 'TR', cities: ['İzmir'] });
  });

  it('refuses a job that is not this workspace claimed job', async () => {
    const { svc } = build();
    await expect(svc.toolContext(FOREIGN, 'job-1')).rejects.toThrow(/no claimed research job/i);
  });
});
