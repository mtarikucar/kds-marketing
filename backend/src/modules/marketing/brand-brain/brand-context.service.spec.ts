import { BrandContextService } from './brand-context.service';

function makeSvc() {
  const prisma: any = {
    brandProfile: {
      findUnique: jest.fn(),
    },
  };
  return { svc: new BrandContextService(prisma), prisma };
}

describe('BrandContextService', () => {
  it('builds a compact block from an ACTIVE profile, omitting empty sections', async () => {
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({
      status: 'ACTIVE',
      brandName: 'Acme',
      description: 'We sell X to Y.',
      valueProps: ['fast', 'cheap'],
      toneWords: ['warm'],
      icpDescription: 'SMB cafes',
      audienceObjections: ['too pricey'],
    });
    const block = await svc.summaryFor('ws-1');
    expect(block).toContain('Brand: Acme');
    expect(block).toContain('We sell X to Y.');
    expect(block).toContain('fast');
    expect(block).toContain('SMB cafes');
  });

  it('returns null for a DRAFT or missing profile (callers behave as before)', async () => {
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({ status: 'DRAFT', brandName: 'Acme' });
    expect(await svc.summaryFor('ws-1')).toBeNull();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue(null);
    expect(await svc.summaryFor('ws-1')).toBeNull();
  });

  it('caches within the TTL — a second summaryFor call within the window does not re-query Prisma', async () => {
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({
      status: 'ACTIVE',
      brandName: 'Acme',
      valueProps: [],
    });
    await svc.summaryFor('ws-1');
    await svc.summaryFor('ws-1');
    expect(prisma.brandProfile.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidate(workspaceId) forces the next summaryFor to re-query Prisma', async () => {
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({
      status: 'ACTIVE',
      brandName: 'Acme',
      valueProps: [],
    });
    await svc.summaryFor('ws-1');
    svc.invalidate('ws-1');
    await svc.summaryFor('ws-1');
    expect(prisma.brandProfile.findUnique).toHaveBeenCalledTimes(2);
  });

  it('bounds the in-memory cache to MAX_CACHE entries with oldest-first eviction', async () => {
    const MAX_CACHE = 1000;
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({
      status: 'ACTIVE',
      brandName: 'Acme',
      valueProps: [],
    });
    for (let i = 0; i < MAX_CACHE + 50; i++) {
      await svc.summaryFor(`ws-${i}`);
    }
    expect((svc as any).cache.size).toBeLessThanOrEqual(MAX_CACHE);
    // Oldest-first: the very first key inserted (ws-0) must be gone, and the
    // most-recently inserted key must still be present.
    expect((svc as any).cache.has('ws-0')).toBe(false);
    expect((svc as any).cache.has(`ws-${MAX_CACHE + 49}`)).toBe(true);
  });

  it('does not evict an unrelated entry when re-summarizing an already-cached key while full (Map.set on an existing key does not grow size)', async () => {
    const MAX_CACHE = 1000;
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({
      status: 'ACTIVE',
      brandName: 'Acme',
      valueProps: [],
    });
    // Fill to exactly MAX_CACHE distinct workspaces.
    for (let i = 0; i < MAX_CACHE; i++) {
      await svc.summaryFor(`ws-${i}`);
    }
    expect((svc as any).cache.size).toBe(MAX_CACHE);

    // Force a MIDDLE key's (not the oldest) TTL to have expired, then re-summarize
    // it — this is a refresh of an EXISTING key, not a new insert. The oldest key
    // (ws-0) is still valid and unrelated to this refresh: it must survive.
    const cache: Map<string, { block: string | null; exp: number }> = (svc as any).cache;
    const entry = cache.get('ws-500')!;
    cache.set('ws-500', { ...entry, exp: Date.now() - 1 });

    await svc.summaryFor('ws-500');

    expect(cache.size).toBe(MAX_CACHE);
    expect(cache.has('ws-500')).toBe(true);
    // The unrelated oldest entry must NOT have been spuriously evicted by this refresh.
    expect(cache.has('ws-0')).toBe(true);
  });
});
