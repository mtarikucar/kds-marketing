import { LeadAttributionService } from './lead-attribution.service';

function makePrisma() {
  const upsert = jest.fn().mockResolvedValue({});
  return { prisma: { leadAttribution: { upsert } } as any, upsert };
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
});
