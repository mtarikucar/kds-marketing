import 'reflect-metadata';
import { ResearchFinalizeService } from './research-finalize.service';
import { ResearchJob } from './research-job.service';

const JOB: ResearchJob = {
  workspaceId: 'ws1',
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
    geo: { country: 'TR' },
    language: 'tr',
    businessTypes: ['SALON'],
    exclusions: null,
    lastRunAt: null,
  },
  remainingToday: 20,
  maxBatchSize: 50,
};

const GOOD = {
  externalRef: 'phone:+905551112233',
  businessName: 'Cafe X',
  businessType: 'CAFE',
  painPoint: 'Slow booking',
  evidence: 'a review',
  pitch: 'merhaba',
};

function build(over: { staged?: number; duplicates?: number } = {}) {
  const candidates = {
    stage: jest.fn().mockResolvedValue({ staged: over.staged ?? 1, duplicates: over.duplicates ?? 0 }),
  };
  const spend = { settle: jest.fn().mockResolvedValue(null) };
  const prisma = { researchProfile: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const svc = new ResearchFinalizeService(prisma as never, candidates as never, spend as never);
  return { svc, candidates, spend, prisma };
}

/**
 * What happens AFTER a research run has produced its final list: validate,
 * clip, stage, meter, stamp the profile.
 *
 * Extracted from the worker for the same reason as the contract itself — the
 * MCP lane's `submit_research_candidates` has to do all five of these things
 * and would otherwise be a second copy of them. A copy that drops the meter
 * bills nothing; a copy that drops the clip stages past the daily quota; a
 * copy that drops the `workspaceId` predicate on the profile stamp writes into
 * a neighbour's row. Five statements is exactly the size of thing that gets
 * duplicated and then quietly diverges.
 */
describe('ResearchFinalizeService', () => {
  it('validates before staging — the malformed candidate never reaches the queue', async () => {
    const { svc, candidates } = build();

    const res = await svc.finalize(JOB, 'run1', [
      GOOD,
      { externalRef: 'not-a-ref', businessName: '', businessType: 'CAFE', painPoint: '', evidence: '', pitch: '' },
    ]);

    expect(res.researched).toBe(1);
    expect(candidates.stage).toHaveBeenCalledWith('ws1', 'p1', 'run1', [
      expect.objectContaining({ externalRef: 'phone:+905551112233' }),
    ]);
  });

  it('clips the batch to what the workspace can still accept', async () => {
    const { svc, candidates } = build();
    const many = Array.from({ length: 30 }, (_v, i) => ({ ...GOOD, externalRef: `domain:biz-${i}.test` }));

    // remainingToday 2 → 2 + 10 headroom = 12.
    await svc.finalize({ ...JOB, remainingToday: 2 }, 'run1', many);

    expect(candidates.stage.mock.calls[0][3]).toHaveLength(12);
  });

  it('meters only what was actually staged, and not at all when nothing was', async () => {
    const { svc, spend } = build({ staged: 3 });
    await svc.finalize(JOB, 'run1', [GOOD]);
    expect(spend.settle).toHaveBeenCalledWith('ws1', {
      unit: 'RESEARCH_LEAD',
      quantity: 3,
      ref: 'run1',
    });

    const none = build({ staged: 0, duplicates: 1 });
    await none.svc.finalize(JOB, 'run1', [GOOD]);
    expect(none.spend.settle).not.toHaveBeenCalled();
  });

  it('stamps the profile INSIDE the caller workspace — never by profile id alone', async () => {
    // The predicate that must fail its own assertion: `id` is a uuid, so a
    // workspaceId-free update is invisible in every happy-path test and only
    // shows up the day two tenants are involved.
    const { svc, prisma } = build({ staged: 2, duplicates: 1 });

    await svc.finalize(JOB, 'run1', [GOOD]);

    const arg = prisma.researchProfile.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'p1', workspaceId: 'ws1' });
    expect(arg.data.lastRunStats).toMatchObject({ posted: 1, staged: 2, duplicates: 1 });
    expect(arg.data.lastRunAt).toBeInstanceOf(Date);
  });

  it('does not lose a staged batch because the profile stamp failed', async () => {
    // The stamp is bookkeeping; the candidates are the product. Throwing here
    // would strand real prospects that are already in the review queue.
    const { svc, prisma } = build({ staged: 2 });
    prisma.researchProfile.updateMany.mockRejectedValue(new Error('db down'));

    await expect(svc.finalize(JOB, 'run1', [GOOD])).resolves.toMatchObject({ staged: 2 });
  });

  it('reports the counts the caller has to render', async () => {
    const { svc } = build({ staged: 1, duplicates: 4 });
    await expect(svc.finalize(JOB, null, [GOOD])).resolves.toEqual({
      researched: 1,
      staged: 1,
      duplicates: 4,
    });
  });
});
