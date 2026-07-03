import { ResearchCandidateService, StagedCandidate } from './research-candidate.service';

const CAND: StagedCandidate = {
  externalRef: 'phone:+905551112233', businessName: 'Cafe X', businessType: 'CAFE',
  painPoint: 'slow booking', evidence: 'review url', pitch: 'hi',
};

function make() {
  const prisma = {
    researchCandidate: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    lead: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const ingest = { ingest: jest.fn().mockResolvedValue({ created: 1, skipped: 0, clipped: 0, errors: [] }) };
  return { svc: new ResearchCandidateService(prisma as any, ingest as any), prisma, ingest };
}

describe('ResearchCandidateService', () => {
  it('stages candidates idempotently (skipDuplicates collapses repeats)', async () => {
    const { svc, prisma } = make();
    (prisma.researchCandidate.createMany as jest.Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const r = await svc.stage('ws1', 'p1', 'run1', [CAND, CAND]);
    expect(r).toEqual({ staged: 1, duplicates: 1 });
    expect(prisma.researchCandidate.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('accept funnels PENDING candidates through ingest() and marks them ACCEPTED', async () => {
    const { svc, prisma, ingest } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([
      { id: 'c1', externalRef: 'phone:+905551112233', businessName: 'Cafe X', businessType: 'CAFE', painPoint: 'p', evidence: 'e', pitch: 'pi', priority: 'HIGH', city: null, region: null, phone: '+905551112233', instagram: null, website: null, email: null, branchCount: null, currentSystem: null, stage: null },
    ]);
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'lead1', externalRef: 'phone:+905551112233' }]);
    const r = await svc.accept('ws1', ['c1']);
    expect(ingest.ingest).toHaveBeenCalledWith('ws1', { leads: [expect.objectContaining({ externalRef: 'phone:+905551112233', painPoint: 'p' })] });
    expect(prisma.researchCandidate.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' }, data: expect.objectContaining({ status: 'ACCEPTED', leadId: 'lead1' }) }));
    expect(r.accepted).toBe(1);
  });

  it('accept is a no-op when nothing is PENDING', async () => {
    const { svc, prisma, ingest } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([]);
    expect(await svc.accept('ws1', ['x'])).toEqual({ accepted: 0, ingest: null });
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('reject marks PENDING candidates REJECTED', async () => {
    const { svc, prisma } = make();
    const r = await svc.reject('ws1', ['c1', 'c2']);
    expect(prisma.researchCandidate.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }));
    expect(r.rejected).toBe(2);
  });
});
