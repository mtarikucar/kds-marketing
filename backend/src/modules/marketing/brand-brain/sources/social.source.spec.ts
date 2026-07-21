import { SocialBrandSource } from './social.source';

function makeSvc(apify: Partial<{ isConfigured: () => boolean; scrapeSocial: jest.Mock }>) {
  const provider: any = { isConfigured: () => true, scrapeSocial: jest.fn(), ...apify };
  return { svc: new SocialBrandSource(provider), provider };
}

describe('SocialBrandSource', () => {
  it('inert when Apify is unconfigured — never calls scrapeSocial', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => false });
    const result = await svc.collect('ws-1', {
      socialHandles: [{ network: 'INSTAGRAM', handle: 'acme' }],
    });
    expect(result).toEqual({ source: 'social', status: 'inert', raw: null });
    expect(provider.scrapeSocial).not.toHaveBeenCalled();
  });

  it('inert when socialHandles is empty/missing (even if configured)', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => true });
    const result = await svc.collect('ws-1', {});
    expect(result).toEqual({ source: 'social', status: 'inert', raw: null });
    expect(provider.scrapeSocial).not.toHaveBeenCalled();
  });

  it('ok: collects hits for every handle and tags each with its network', async () => {
    const hit = { handle: '@acme', fullName: 'Acme', bio: 'we sell x' };
    const { svc, provider } = makeSvc({ isConfigured: () => true, scrapeSocial: jest.fn().mockResolvedValue(hit) });
    const result = await svc.collect('ws-1', {
      socialHandles: [
        { network: 'INSTAGRAM', handle: 'acme' },
        { network: 'FACEBOOK', handle: 'acmepage' },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.raw).toEqual([
      { network: 'INSTAGRAM', ...hit },
      { network: 'FACEBOOK', ...hit },
    ]);
    expect(result.apifyRuns).toBe(2);
    expect(provider.scrapeSocial).toHaveBeenNthCalledWith(1, 'INSTAGRAM', 'acme');
    expect(provider.scrapeSocial).toHaveBeenNthCalledWith(2, 'FACEBOOK', 'acmepage');
  });

  it('error isolation: one handle rejecting does not fail the source and is excluded from apifyRuns', async () => {
    const goodHit = { handle: '@acme', fullName: 'Acme' };
    const scrapeSocial = jest
      .fn()
      .mockRejectedValueOnce(new Error('bad handle'))
      .mockResolvedValueOnce(goodHit);
    const { svc } = makeSvc({ isConfigured: () => true, scrapeSocial });
    const result = await svc.collect('ws-1', {
      socialHandles: [
        { network: 'FACEBOOK', handle: 'broken' },
        { network: 'INSTAGRAM', handle: 'acme' },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.raw).toEqual([{ network: 'INSTAGRAM', ...goodHit }]);
    expect(result.apifyRuns).toBe(1);
  });
});
