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

  it('leaves a quota-CLIPPED candidate PENDING (only the linked one is marked ACCEPTED)', async () => {
    const { svc, prisma, ingest } = make();
    const base = { businessName: 'X', businessType: 'CAFE', painPoint: 'p', evidence: 'e', pitch: 'pi', priority: 'HIGH', city: null, region: null, instagram: null, website: null, email: null, branchCount: null, currentSystem: null, stage: null };
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([
      { id: 'c1', externalRef: 'phone:+901', phone: '+901', ...base },
      { id: 'c2', externalRef: 'phone:+902', phone: '+902', ...base }, // clipped by the daily quota → no lead
    ]);
    (ingest.ingest as jest.Mock).mockResolvedValue({ created: 1, skipped: 0, clipped: 1, errors: [] });
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'lead1', externalRef: 'phone:+901' }]); // only c1 got a lead

    const r = await svc.accept('ws1', ['c1', 'c2']);

    // c1 is accepted+linked; c2 is NOT updated (stays PENDING so it can be accepted tomorrow).
    expect(prisma.researchCandidate.update).toHaveBeenCalledTimes(1);
    expect(prisma.researchCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: expect.objectContaining({ status: 'ACCEPTED', leadId: 'lead1' }) }),
    );
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

/**
 * Ordering the review queue.
 *
 * `score` is whatever the research model returned. Real runs in one workspace
 * came back on three different scales in the same night — 58, 7.5 and 0.82 —
 * so score-first ordering ranked candidates against numbers that did not mean
 * the same thing. The worst case is not cosmetic: a 1-branch business whose own
 * evidence text said it fails the ICP sat at the top of the queue, above a
 * HIGH-priority match, because its run happened to score out of 100.
 */
describe('ResearchCandidateService.list — ordering', () => {
  const row = (id: string, priority: string, score: number | null) =>
    ({ id, priority, score }) as any;

  it('ranks by priority before score, so scales cannot cross-contaminate', async () => {
    const { svc, prisma } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([
      row('bulla', 'MEDIUM', 58), // scored 0-100
      row('konyalilar', 'HIGH', 7.5), // scored 0-10
      row('bulut', 'HIGH', 0.82), // scored 0-1
      row('bicaksiz', 'LOW', 42),
    ]);

    const out = await svc.list('ws1');

    expect(out.map((r: any) => r.id)).toEqual(['konyalilar', 'bulut', 'bulla', 'bicaksiz']);
  });

  it('sorts URGENT above HIGH — String columns sort alphabetically in SQL', async () => {
    const { svc, prisma } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([
      row('a', 'MEDIUM', 0),
      row('b', 'URGENT', 0),
      row('c', 'LOW', 0),
      row('d', 'HIGH', 0),
    ]);

    const out = await svc.list('ws1');

    expect(out.map((r: any) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('takes the 200-row cut by recency, not by the untrusted score', async () => {
    const { svc, prisma } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([]);

    await svc.list('ws1');

    // A score-ordered cut would decide what a reviewer never sees using the
    // same number we just established is not comparable across runs.
    expect(prisma.researchCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  });

  it('puts a missing score last within its priority band', async () => {
    const { svc, prisma } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([
      row('noscore', 'HIGH', null),
      row('zero', 'HIGH', 0),
    ]);

    const out = await svc.list('ws1');

    // 0 is a real "does not fit" verdict; null is the model declining to say.
    expect(out.map((r: any) => r.id)).toEqual(['zero', 'noscore']);
  });
});

/**
 * A candidate that duplicates a lead already in the CRM.
 *
 * Ingest dedups on the CONTACT match keys as well as externalRef, so a
 * phone-keyed candidate can be recognised as a duplicate of a lead that arrived
 * from a form under a different externalRef. Linking back by externalRef alone
 * missed exactly those: ingest reported them `skipped`, no lead was found, and
 * they sat PENDING forever — re-offered at every review, impossible to accept
 * because there is nothing left to create, and clogging the review queue. Four
 * were stuck this way in production.
 *
 * The distinction that has to survive: "already in the CRM" (link it, ACCEPTED)
 * versus "not ingested yet, quota clipped" (leave PENDING so it can be accepted
 * tomorrow).
 */
describe('ResearchCandidateService.accept — duplicate of an existing lead', () => {
  const CAND = {
    id: 'c1', externalRef: 'phone:+905551112233', businessName: 'Cafe X', businessType: 'CAFE',
    painPoint: 'p', evidence: 'e', pitch: 'pi', priority: 'HIGH',
    city: null, region: null, phone: '+905551112233', instagram: null, website: null,
    email: null, branchCount: null, currentSystem: null, stage: null,
  };

  const setup = (leadsByRef: any[], leadsByContact: any[]) => {
    const { svc, prisma, ingest } = make();
    (prisma.researchCandidate.findMany as jest.Mock).mockResolvedValue([CAND]);
    (ingest.ingest as jest.Mock).mockResolvedValue({ created: 0, skipped: 1, clipped: 0, errors: [] });
    (prisma.lead.findMany as jest.Mock)
      .mockResolvedValueOnce(leadsByRef)      // by externalRef
      .mockResolvedValueOnce(leadsByContact); // by contact keys
    return { svc, prisma };
  };

  it('links a candidate to the existing lead it duplicates and marks it ACCEPTED', async () => {
    const { svc, prisma } = setup([], [{ id: 'lead-form-1', phoneNormalized: '905551112233', emailNormalized: null }]);

    const r = await svc.accept('ws1', ['c1']);

    expect(r.accepted).toBe(1);
    expect(prisma.researchCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED', leadId: 'lead-form-1' }) }),
    );
  });

  it('matches across phone spellings, not just the stored one', async () => {
    // The lead came in as "05551112233"; the candidate carries E.164.
    const { svc, prisma } = setup([], [{ id: 'lead-2', phoneNormalized: '05551112233', emailNormalized: null }]);

    await svc.accept('ws1', ['c1']);

    expect(prisma.researchCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leadId: 'lead-2' }) }),
    );
  });

  it('still leaves a quota-clipped candidate PENDING', async () => {
    // No lead anywhere: nothing was created and nothing pre-existed, so this
    // must stay acceptable tomorrow rather than vanishing as ACCEPTED with a
    // null leadId.
    const { svc, prisma } = setup([], []);

    const r = await svc.accept('ws1', ['c1']);

    expect(r.accepted).toBe(0);
    expect(prisma.researchCandidate.update).not.toHaveBeenCalled();
  });

  it('prefers the externalRef match when there is one', async () => {
    const { svc, prisma } = setup([{ id: 'lead-ref', externalRef: 'phone:+905551112233' }], []);

    await svc.accept('ws1', ['c1']);

    expect(prisma.researchCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leadId: 'lead-ref' }) }),
    );
  });
});
