import { Logger, NotFoundException } from '@nestjs/common';
import { InternalResearchController } from './internal-research.controller';
import { ResearchJobService } from '../marketing/research/research-job.service';
import { MarketingLeadsIngestService } from '../marketing/services/marketing-leads-ingest.service';

/**
 * The external research routine's HTTP surface.
 *
 * These specs wire the REAL {@link ResearchJobService} and
 * {@link MarketingLeadsIngestService} over a workspace-aware fake Prisma rather
 * than stubbing them out, because the properties worth locking here are the
 * ones that only emerge from the composition:
 *
 *   - GET  /jobs        — the work-list contract ({ generatedAt, jobs })
 *   - POST /jobs/:ws/leads — the ingest contract
 *                          ({ created, skipped, clipped, errors, quota })
 *   - a caller holding the routine token cannot read or write OUTSIDE the
 *     workspace named in the path (this is a cross-workspace surface: one
 *     credential, every tenant)
 *
 * The fake mimics Prisma's most dangerous semantic on purpose: an `undefined`
 * key in a `where` is IGNORED, not matched. So if a workspace scope is ever
 * dropped from a query, these tests see the other tenant's rows and fail —
 * which is the whole point.
 */

const PERIOD_KEY = new Date().toISOString().slice(0, 10);

interface FakeDb {
  workspaces: any[];
  profiles: any[];
  leads: any[];
  counters: Record<string, number>;
  activities: any[];
}

function candidate(n: number) {
  return {
    externalRef: `instagram:@biz${n}`,
    businessName: `Biz ${n}`,
    businessType: 'CAFE',
    painPoint: 'p',
    evidence: 'e',
    pitch: 'pi',
  } as any;
}

/** Prisma's rule: a where key whose value is `undefined` is not a filter at all. */
const matches = (row: any, where: any, keys: string[]) =>
  keys.every((k) => where[k] === undefined || row[k] === where[k]);

function makeFakePrisma(db: FakeDb) {
  const counterKey = (a: any) => {
    const k = a.where.workspaceId_metric_periodKey;
    return `${k.workspaceId}|${k.metric}|${k.periodKey}`;
  };
  let leadSeq = 0;

  const prisma: any = {
    workspace: {
      findMany: jest.fn(async ({ where }: any) =>
        db.workspaces.filter((w) => matches(w, where ?? {}, ['status', 'id'])),
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          db.workspaces.find((w) => matches(w, where, ['id', 'status'])) ?? null,
      ),
    },
    researchProfile: {
      findMany: jest.fn(async ({ where }: any) =>
        db.profiles.filter((p) => matches(p, where, ['workspaceId', 'status'])),
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          db.profiles.find((p) =>
            matches(p, where, ['id', 'workspaceId', 'status']),
          ) ?? null,
      ),
    },
    marketingUser: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: `sentinel-${where.workspaceId}`,
      })),
    },
    lead: {
      findMany: jest.fn(async ({ where }: any) =>
        db.leads
          .filter(
            (l) =>
              matches(l, where, ['workspaceId']) &&
              (where.externalRef?.in === undefined ||
                where.externalRef.in.includes(l.externalRef)),
          )
          .map((l) => ({ externalRef: l.externalRef })),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `lead-${++leadSeq}`, ...data };
        db.leads.push(row);
        return row;
      }),
    },
    leadActivity: {
      create: jest.fn(async ({ data }: any) => {
        db.activities.push(data);
        return data;
      }),
    },
    usageCounter: {
      findUnique: jest.fn(async (a: any) => {
        const v = db.counters[counterKey(a)];
        return v === undefined ? null : { value: v };
      }),
      upsert: jest.fn(async (a: any) => {
        const k = counterKey(a);
        if (db.counters[k] === undefined) db.counters[k] = a.create.value;
        else db.counters[k] += a.update.value.increment;
        return { value: db.counters[k] };
      }),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return prisma;
}

describe('InternalResearchController', () => {
  const WS_A = {
    id: 'ws-a',
    slug: 'alpha',
    status: 'ACTIVE',
    productName: 'Alpha POS',
    productUrl: 'https://alpha.test',
    productDescription: 'Alpha desc',
    defaultLanguage: 'tr',
  };
  const WS_B = {
    id: 'ws-b',
    slug: 'beta',
    status: 'ACTIVE',
    productName: 'Beta POS',
    productUrl: null,
    productDescription: null,
    defaultLanguage: 'en',
  };
  const PROFILE_A = {
    id: 'prof-a',
    workspaceId: 'ws-a',
    status: 'ACTIVE',
    name: 'Cafes Istanbul',
    icpDescription: 'busy cafes',
    productPitch: 'faster service',
    geo: { city: 'Istanbul' },
    language: 'tr',
    businessTypes: ['CAFE'],
    exclusions: null,
    lastRunAt: null,
  };
  const PROFILE_B = {
    id: 'prof-b',
    workspaceId: 'ws-b',
    status: 'ACTIVE',
    name: 'Bakeries Berlin',
    icpDescription: 'bakeries',
    productPitch: null,
    geo: { city: 'Berlin' },
    language: 'en',
    businessTypes: ['BAKERY'],
    exclusions: null,
    lastRunAt: null,
  };

  let db: FakeDb;
  let prisma: any;
  let quotas: Record<string, number>;
  let quotaResolver: { getDailyLeadQuota: jest.Mock };
  let ingest: MarketingLeadsIngestService;
  let jobs: ResearchJobService;
  let ctrl: InternalResearchController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    db = {
      workspaces: [{ ...WS_A }, { ...WS_B }],
      profiles: [{ ...PROFILE_A }, { ...PROFILE_B }],
      leads: [],
      counters: {},
      activities: [],
    };
    quotas = { 'ws-a': 10, 'ws-b': 10 };
    prisma = makeFakePrisma(db);
    quotaResolver = {
      getDailyLeadQuota: jest.fn(async (ws: string) => quotas[ws] ?? 10),
    };
    ingest = new MarketingLeadsIngestService(
      prisma,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      quotaResolver as any,
    );
    jobs = new ResearchJobService(prisma, ingest);
    ctrl = new InternalResearchController(jobs, ingest);
  });

  afterEach(() => jest.restoreAllMocks());

  const usedFor = (ws: string) =>
    db.counters[`${ws}|leads.ingested|${PERIOD_KEY}`] ?? 0;

  // ---------------------------------------------------------------- GET /jobs

  describe('GET /internal/research/jobs', () => {
    it('returns { generatedAt, jobs: [] } when no ACTIVE profile exists', async () => {
      db.profiles = [];
      const res = await ctrl.listJobs();

      expect(res.jobs).toEqual([]);
      expect(typeof res.generatedAt).toBe('string');
      expect(new Date(res.generatedAt).toISOString()).toBe(res.generatedAt);
    });

    it('returns an empty list when there is no ACTIVE workspace at all', async () => {
      db.workspaces = [{ ...WS_A, status: 'SUSPENDED' }];
      const res = await ctrl.listJobs();
      expect(res.jobs).toEqual([]);
      // Never even looked for profiles of an inactive workspace.
      expect(prisma.researchProfile.findMany).not.toHaveBeenCalled();
    });

    it('returns one populated job per ACTIVE profile of each ACTIVE workspace', async () => {
      const res = await ctrl.listJobs();

      expect(res.jobs).toHaveLength(2);
      expect(res.jobs[0]).toMatchObject({
        workspaceId: 'ws-a',
        workspaceSlug: 'alpha',
        productName: 'Alpha POS',
        productUrl: 'https://alpha.test',
        defaultLanguage: 'tr',
        remainingToday: 10,
        maxBatchSize: 50,
        leadRules: null,
      });
      expect(res.jobs[0].profile).toMatchObject({
        id: 'prof-a',
        name: 'Cafes Istanbul',
        icpDescription: 'busy cafes',
        language: 'tr',
      });
      expect(res.jobs[1]).toMatchObject({ workspaceId: 'ws-b', profile: { id: 'prof-b' } });
    });

    it('only ever asks for ACTIVE workspaces and ACTIVE profiles scoped to them', async () => {
      await ctrl.listJobs();

      expect(prisma.workspace.findMany.mock.calls[0][0].where).toMatchObject({
        status: 'ACTIVE',
      });
      for (const [args] of prisma.researchProfile.findMany.mock.calls) {
        expect(args.where.status).toBe('ACTIVE');
        expect(args.where.workspaceId).toBeDefined();
      }
    });

    it('omits INACTIVE profiles and INACTIVE workspaces', async () => {
      db.profiles[0].status = 'PAUSED';
      db.workspaces[1].status = 'SUSPENDED';
      const res = await ctrl.listJobs();
      expect(res.jobs).toEqual([]);
    });

    it('omits a workspace whose daily quota is already exhausted', async () => {
      db.counters[`ws-a|leads.ingested|${PERIOD_KEY}`] = 10; // limit 10, used 10
      const res = await ctrl.listJobs();
      expect(res.jobs.map((j: any) => j.workspaceId)).toEqual(['ws-b']);
    });

    it('reports the REMAINING daily budget per workspace, not the limit', async () => {
      db.counters[`ws-a|leads.ingested|${PERIOD_KEY}`] = 7;
      const res = await ctrl.listJobs();
      expect(res.jobs.find((j: any) => j.workspaceId === 'ws-a').remainingToday).toBe(3);
    });
  });

  // ------------------------------------------------- POST /jobs/:ws/leads

  describe('POST /internal/research/jobs/:workspaceId/leads', () => {
    const body = (n: number[], profileId = 'prof-a') =>
      ({ profileId, leads: n.map(candidate) }) as any;

    it('returns the full { created, skipped, clipped, errors, quota } contract', async () => {
      const res = await ctrl.submitLeads('ws-a', body([1, 2]));

      expect(res).toEqual({
        created: 2,
        skipped: 0,
        clipped: 0,
        errors: [],
        quota: { limit: 10, used: 2, remaining: 8 },
      });
      expect(Object.keys(res).sort()).toEqual(
        ['clipped', 'created', 'errors', 'quota', 'skipped'].sort(),
      );
    });

    it('404s an unknown workspaceId', async () => {
      await expect(ctrl.submitLeads('ws-nope', body([1]))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    it('404s a SUSPENDED workspace', async () => {
      db.workspaces[0].status = 'SUSPENDED';
      await expect(ctrl.submitLeads('ws-a', body([1]))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    it('404s an unknown profileId', async () => {
      await expect(
        ctrl.submitLeads('ws-a', body([1], 'prof-nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    it('404s a non-ACTIVE profile', async () => {
      db.profiles[0].status = 'PAUSED';
      await expect(ctrl.submitLeads('ws-a', body([1]))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s once the workspace quota is exhausted (no writes)', async () => {
      db.counters[`ws-a|leads.ingested|${PERIOD_KEY}`] = 10;
      await expect(ctrl.submitLeads('ws-a', body([1]))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    // ------------------------------------------------ cross-workspace isolation

    describe('cross-workspace isolation', () => {
      it('404s a profile that belongs to ANOTHER workspace', async () => {
        await expect(
          ctrl.submitLeads('ws-a', body([1], 'prof-b')),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.lead.create).not.toHaveBeenCalled();
        // The profile lookup must be scoped by the PATH workspace, always.
        for (const [args] of prisma.researchProfile.findFirst.mock.calls) {
          expect(args.where.workspaceId).toBe('ws-a');
        }
      });

      it('writes leads ONLY into the path workspace, never the sibling', async () => {
        await ctrl.submitLeads('ws-a', body([1, 2, 3]));

        expect(db.leads).toHaveLength(3);
        expect(db.leads.every((l) => l.workspaceId === 'ws-a')).toBe(true);
        expect(db.leads.some((l) => l.workspaceId === 'ws-b')).toBe(false);
        for (const [args] of prisma.lead.create.mock.calls) {
          expect(args.data.workspaceId).toBe('ws-a');
        }
      });

      it('burns quota ONLY on the path workspace', async () => {
        await ctrl.submitLeads('ws-a', body([1, 2]));
        expect(usedFor('ws-a')).toBe(2);
        expect(usedFor('ws-b')).toBe(0);
      });

      it('never lets a body field redirect the write to another workspace', async () => {
        // The routine controls the body; the path is the only authority. A
        // smuggled workspaceId must be inert.
        await ctrl.submitLeads('ws-a', {
          ...body([1]),
          workspaceId: 'ws-b',
        } as any);
        expect(db.leads.map((l) => l.workspaceId)).toEqual(['ws-a']);
        expect(usedFor('ws-b')).toBe(0);
      });

      it('scopes the sentinel + dedup + activity writes to the path workspace', async () => {
        await ctrl.submitLeads('ws-a', body([1]));

        expect(prisma.marketingUser.findFirst.mock.calls[0][0].where).toMatchObject({
          workspaceId: 'ws-a',
          role: 'SYSTEM',
        });
        expect(prisma.lead.findMany.mock.calls[0][0].where.workspaceId).toBe('ws-a');
        expect(db.activities[0].createdById).toBe('sentinel-ws-a');
      });

      it('does NOT suppress a lead in A just because B already holds the same externalRef', async () => {
        db.leads.push({
          id: 'pre-b',
          workspaceId: 'ws-b',
          externalRef: 'instagram:@biz1',
        });

        const res = await ctrl.submitLeads('ws-a', body([1]));

        expect(res).toMatchObject({ created: 1, skipped: 0 });
        expect(
          db.leads.filter((l) => l.workspaceId === 'ws-a'),
        ).toHaveLength(1);
      });

      it('GET /jobs and POST /leads read the same tenant boundary (A cannot see B via a job)', async () => {
        const res = await ctrl.listJobs();
        const aJob = res.jobs.find((j: any) => j.workspaceId === 'ws-a');
        // The job handed to the routine for A carries A's profile only.
        expect(aJob.profile.id).toBe('prof-a');
        // ...and that profile id is the only one A can submit under.
        await expect(
          ctrl.submitLeads('ws-a', body([1], 'prof-b')),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(ctrl.submitLeads('ws-a', body([1], aJob.profile.id))).resolves
          .toMatchObject({ created: 1 });
      });
    });

    // ------------------------------------------------- quota clipping / dedup

    describe('quota clipping and dedup', () => {
      it('populates `clipped` when the batch exceeds the remaining budget', async () => {
        quotas['ws-a'] = 2;
        const res = await ctrl.submitLeads('ws-a', body([1, 2, 3, 4]));

        expect(res).toMatchObject({
          created: 2,
          clipped: 2,
          skipped: 0,
          quota: { limit: 2, used: 2, remaining: 0 },
        });
        expect(prisma.lead.create).toHaveBeenCalledTimes(2);
      });

      it('clips against the budget ALREADY consumed earlier today', async () => {
        quotas['ws-a'] = 3;
        db.counters[`ws-a|leads.ingested|${PERIOD_KEY}`] = 2;
        const res = await ctrl.submitLeads('ws-a', body([1, 2, 3]));
        expect(res).toMatchObject({ created: 1, clipped: 2, quota: { remaining: 0 } });
      });

      it('populates `skipped` for an externalRef already present in THIS workspace', async () => {
        db.leads.push({
          id: 'pre-a',
          workspaceId: 'ws-a',
          externalRef: 'instagram:@biz1',
        });
        const res = await ctrl.submitLeads('ws-a', body([1, 2]));

        expect(res).toMatchObject({ created: 1, skipped: 1, clipped: 0 });
        expect(res.quota.used).toBe(1); // a dupe must not burn quota
      });

      it('collapses intra-batch duplicate refs into one create', async () => {
        const dup = candidate(1);
        const res = await ctrl.submitLeads('ws-a', {
          profileId: 'prof-a',
          leads: [dup, dup, candidate(2)],
        } as any);
        expect(res).toMatchObject({ created: 2, skipped: 1 });
      });

      it('populates `errors` (and settles the quota) when a row fails to insert', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        prisma.lead.create
          .mockImplementationOnce(async ({ data }: any) => {
            db.leads.push({ id: 'ok', ...data });
            return { id: 'ok', ...data };
          })
          .mockRejectedValueOnce(new Error('row exploded'));

        const res = await ctrl.submitLeads('ws-a', body([1, 2]));

        expect(res.created).toBe(1);
        expect(res.errors).toEqual([
          { externalRef: 'instagram:@biz2', error: 'row exploded' },
        ]);
        // Reserved 2, created 1 → the unused slot goes back to the day's budget.
        expect(usedFor('ws-a')).toBe(1);
        expect(res.quota).toMatchObject({ used: 1, remaining: 9 });
      });

      it('reports remaining -1 for an unlimited workspace and clips nothing', async () => {
        quotas['ws-a'] = -1;
        const res = await ctrl.submitLeads('ws-a', body([1, 2, 3]));
        expect(res).toMatchObject({
          created: 3,
          clipped: 0,
          quota: { limit: -1, remaining: -1 },
        });
      });
    });
  });
});
