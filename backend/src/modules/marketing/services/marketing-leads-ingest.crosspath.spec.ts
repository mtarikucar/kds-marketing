import { MarketingLeadsIngestService } from './marketing-leads-ingest.service';

/**
 * Cross-path dedup (v2.178.1).
 *
 * `mapToLeadData` has always written phoneNormalized/emailNormalized with a
 * comment saying they exist so an AI-researched lead collides with a
 * form/manual/booking lead for the same business. Nothing read them: research
 * matched on its OWN externalRef only, so a prospect already in the CRM under
 * any other origin was minted a second time.
 *
 * Found live — three researched prospects were staged for a workspace that
 * already held all three as manually-entered leads with matching phones and no
 * externalRef. Accepting them would have produced six rows for three
 * businesses, two owners each, and two reps calling the same company.
 *
 * meta-leadgen and voice-ai already dedup on these keys; research was the one
 * inbound path that did not.
 */
describe('MarketingLeadsIngestService — cross-path dedup', () => {
  const WS = 'ws-1';

  function candidate(over: Record<string, unknown> = {}) {
    return {
      externalRef: 'phone:+902164185222',
      businessName: 'HTC Events',
      businessType: 'ETKINLIK_AJANSI',
      phone: '+90 216 418 52 22',
      painPoint: 'p',
      evidence: 'e',
      pitch: 'pi',
      ...over,
    } as never;
  }

  let prisma: any;
  let svc: MarketingLeadsIngestService;

  beforeEach(() => {
    let counterValue = 0;
    prisma = {
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sentinel-1' }) },
      lead: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'new-lead', ...data })),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      usageCounter: {
        findUnique: jest.fn().mockImplementation(async () => (counterValue > 0 ? { value: counterValue } : null)),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          if (args.update?.value?.increment !== undefined) counterValue += args.update.value.increment;
          else if (args.create?.value !== undefined && counterValue === 0) counterValue = args.create.value;
          return { value: counterValue };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    svc = new MarketingLeadsIngestService(
      prisma,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as never,
      { getDailyLeadQuota: jest.fn().mockResolvedValue(50) } as never,
    );
  });

  it('does not mint a second lead for a business already in the CRM by phone', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', externalRef: null });

    const res = await svc.ingest(WS, { leads: [candidate()] } as never);

    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ created: 0, skipped: 1 });
  });

  /**
   * The stamp is what keeps `ResearchCandidateService.accept` able to link an
   * adopted candidate to its lead — accept looks the ref up AFTER ingest, so
   * without this the candidate finds nothing, stays PENDING forever, and is
   * re-offered by every future run.
   */
  it('stamps the research ref onto the adopted lead so accept can link it', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', externalRef: null });

    await svc.ingest(WS, { leads: [candidate()] } as never);

    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'existing-1', externalRef: null },
      data: { externalRef: 'phone:+902164185222' },
    });
  });

  it('leaves an existing ref alone rather than overwriting another origin key', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', externalRef: 'form:abc' });

    await svc.ingest(WS, { leads: [candidate()] } as never);

    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('matches across stored phone spellings, not just the exact normalized form', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', externalRef: null });

    await svc.ingest(WS, { leads: [candidate()] } as never);

    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    const phoneClause = where.OR.find((c: any) => c.phoneNormalized);
    expect(phoneClause.phoneNormalized.in.length).toBeGreaterThan(1);
    // A workspace that hid or merged a lead must not have it silently revived
    // as the destination for a fresh prospect.
    expect(where).toMatchObject({ mergedIntoId: null, deletedAt: null });
  });

  it('adopting consumes no daily quota — it created nothing', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', externalRef: null });

    const res = await svc.ingest(WS, { leads: [candidate()] } as never);

    expect(res.quota).toMatchObject({ used: 0, remaining: 50 });
  });

  it('still creates when the prospect is genuinely new', async () => {
    const res = await svc.ingest(WS, { leads: [candidate()] } as never);

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ created: 1, skipped: 0 });
  });

  it('skips the contact probe entirely when a candidate has no phone or email', async () => {
    await svc.ingest(WS, {
      leads: [candidate({ phone: undefined, externalRef: 'instagram:@x' })],
    } as never);

    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
  });

  /**
   * Best-effort by design: losing a race on the stamp must not resurrect the
   * duplicate the whole check exists to prevent.
   */
  it('still dedups when the ref stamp fails', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', externalRef: null });
    prisma.lead.updateMany.mockRejectedValue(new Error('conflict'));

    const res = await svc.ingest(WS, { leads: [candidate()] } as never);

    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ created: 0, skipped: 1 });
  });
});
