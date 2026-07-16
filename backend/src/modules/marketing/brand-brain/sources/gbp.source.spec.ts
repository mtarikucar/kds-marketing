import { GbpBrandSource } from './gbp.source';

function makeSvc(apify: Partial<{ isConfigured: () => boolean; scrapeGoogleBusiness: jest.Mock }>) {
  const provider: any = { isConfigured: () => true, scrapeGoogleBusiness: jest.fn(), ...apify };
  return { svc: new GbpBrandSource(provider), provider };
}

describe('GbpBrandSource', () => {
  it('inert when Apify is unconfigured — never calls scrapeGoogleBusiness', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => false });
    const result = await svc.collect('ws-1', { gbpQuery: 'Acme Cafe Izmir' });
    expect(result).toEqual({ source: 'gbp', status: 'inert', raw: null });
    expect(provider.scrapeGoogleBusiness).not.toHaveBeenCalled();
  });

  it('inert when gbpQuery is missing (even if configured)', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => true });
    const result = await svc.collect('ws-1', {});
    expect(result).toEqual({ source: 'gbp', status: 'inert', raw: null });
    expect(provider.scrapeGoogleBusiness).not.toHaveBeenCalled();
  });

  it('ok: returns the place hit and apifyRuns:1', async () => {
    const place = { name: 'Acme Cafe', address: '123 Main' };
    const { svc, provider } = makeSvc({
      isConfigured: () => true,
      scrapeGoogleBusiness: jest.fn().mockResolvedValue(place),
    });
    const result = await svc.collect('ws-1', { gbpQuery: 'Acme Cafe Izmir' });
    expect(result).toEqual({ source: 'gbp', status: 'ok', raw: place, apifyRuns: 1 });
    expect(provider.scrapeGoogleBusiness).toHaveBeenCalledWith('Acme Cafe Izmir');
  });

  it('error isolation: a throwing scrapeGoogleBusiness() resolves status:error instead of rejecting', async () => {
    const { svc } = makeSvc({
      isConfigured: () => true,
      scrapeGoogleBusiness: jest.fn().mockRejectedValue(new Error('actor failed')),
    });
    const result = await svc.collect('ws-1', { gbpQuery: 'Acme Cafe Izmir' });
    expect(result.status).toBe('error');
    expect(result.raw).toBeNull();
    expect(result.error).toBe('actor failed');
  });
});
