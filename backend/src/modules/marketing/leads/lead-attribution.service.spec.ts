import { LeadAttributionService } from './lead-attribution.service';

function makePrisma(adMetricHit: { campaignId: string } | null = null) {
  const upsert = jest.fn().mockResolvedValue({});
  const adMetricFindFirst = jest.fn().mockResolvedValue(adMetricHit);
  return {
    prisma: { leadAttribution: { upsert }, adMetric: { findFirst: adMetricFindFirst } } as any,
    upsert,
    adMetricFindFirst,
  };
}

describe('LeadAttributionService', () => {
  it('skips the write when there is no attribution signal and no source', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { url: 'https://x.co/lp', referrer: 'https://google.com' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('upserts first-touch (create with parsed + source, empty update) when a UTM signal exists', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new LeadAttributionService(prisma);
    await svc.capture(
      'ws1',
      'lead1',
      { url: 'https://x.co/lp?utm_source=instagram&fbclid=ABC' },
      { sourceSocialPostId: 'post-9' },
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ leadId: 'lead1' });
    expect(arg.update).toEqual({}); // first-touch wins
    expect(arg.create).toMatchObject({
      workspaceId: 'ws1',
      lead: { connect: { id: 'lead1' } },
      utmSource: 'instagram',
      clickId: 'ABC',
      clickIdType: 'FBCLID',
      sourceSocialPostId: 'post-9',
    });
    expect(arg.create.raw).toBeDefined();
  });

  it('writes when only a content source is known (no click/UTM)', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', {}, { sourceAdCampaignId: 'camp-1' });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create).toMatchObject({ sourceAdCampaignId: 'camp-1' });
  });

  it('captures a CTWA referral even with no URL', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { ctwaClid: 'wa-1' });
    expect(upsert.mock.calls[0][0].create).toMatchObject({ ctwaClid: 'wa-1' });
  });

  it('never throws when the write fails (best-effort contract)', async () => {
    const { prisma, upsert } = makePrisma();
    upsert.mockRejectedValueOnce(new Error('db down'));
    const svc = new LeadAttributionService(prisma);
    await expect(svc.capture('ws1', 'lead1', { ctwaClid: 'wa-1' })).resolves.toBeUndefined();
  });

  it('uses the provided transaction client when passed', async () => {
    const { prisma } = makePrisma();
    const txUpsert = jest.fn().mockResolvedValue({});
    const tx = { leadAttribution: { upsert: txUpsert } } as any;
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { ctwaClid: 'wa-1' }, {}, tx);
    expect(txUpsert).toHaveBeenCalledTimes(1);
    expect(prisma.leadAttribution.upsert).not.toHaveBeenCalled();
  });

  // ── D10a/D10c deterministic resolver wiring ─────────────────────────────────

  it('resolves utm_campaign → sourceAdCampaignId when it matches a workspace AdMetric.campaignId', async () => {
    const { prisma, upsert, adMetricFindFirst } = makePrisma({ campaignId: 'meta-c-1' });
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { url: 'https://x.co/lp?utm_source=fb&utm_campaign=meta-c-1' });
    expect(adMetricFindFirst.mock.calls[0][0].where).toEqual({ workspaceId: 'ws1', campaignId: 'meta-c-1' });
    expect(upsert.mock.calls[0][0].create).toMatchObject({
      utmCampaign: 'meta-c-1',
      sourceAdCampaignId: 'meta-c-1',
    });
  });

  it('leaves a non-matching utm_campaign unresolved (row still written, no ref)', async () => {
    const { prisma, upsert } = makePrisma(null);
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { url: 'https://x.co/lp?utm_campaign=summer' });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.sourceAdCampaignId).toBeUndefined();
  });

  it('a jg_cid-ONLY url (no UTM/click-id) still writes an attributed row', async () => {
    const { prisma, upsert, adMetricFindFirst } = makePrisma();
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { url: 'https://x.co/lp?jg_cid=camp-9' });
    expect(adMetricFindFirst).not.toHaveBeenCalled(); // explicit param — trusted, no lookup
    expect(upsert.mock.calls[0][0].create).toMatchObject({ sourceAdCampaignId: 'camp-9' });
  });

  it('utm_source=social + jg_pid → sourceSocialPostId (D10c)', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new LeadAttributionService(prisma);
    await svc.capture('ws1', 'lead1', { url: 'https://x.co/lp?utm_source=social&jg_pid=post-3' });
    expect(upsert.mock.calls[0][0].create).toMatchObject({ sourceSocialPostId: 'post-3' });
  });

  it('a caller-supplied source ref wins over the resolver (no lookup spent)', async () => {
    const { prisma, upsert, adMetricFindFirst } = makePrisma({ campaignId: 'other' });
    const svc = new LeadAttributionService(prisma);
    await svc.capture(
      'ws1',
      'lead1',
      { url: 'https://x.co/lp?utm_campaign=other' },
      { sourceAdCampaignId: 'caller-c' },
    );
    expect(adMetricFindFirst).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][0].create).toMatchObject({ sourceAdCampaignId: 'caller-c' });
  });

  it('a resolver DB failure never blocks the attribution write (best-effort)', async () => {
    const { prisma, upsert, adMetricFindFirst } = makePrisma();
    adMetricFindFirst.mockRejectedValueOnce(new Error('db down'));
    const svc = new LeadAttributionService(prisma);
    await expect(
      svc.capture('ws1', 'lead1', { url: 'https://x.co/lp?utm_campaign=c1' }),
    ).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1); // UTM row still recorded, just unresolved
  });
});
