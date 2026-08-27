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

/**
 * What we sell, and what it costs.
 *
 * `offerings` was the one field render() dropped, and it is the field that
 * carries the price list. That put the agent in an impossible position: its
 * goals tell it to say a paid module's price honestly, while the only prices
 * reaching it were whichever ones happened to be written into a value prop.
 * Asked "how much is the extra-branch module?", it could only refuse or invent.
 *
 * On this brand the whole pitch is that there are no traps and no hidden tiers —
 * improvising a number is the single most damaging thing it could do.
 */
describe('BrandContextService.render — offerings', () => {
  const build = (profile: Record<string, unknown>) => {
    const prisma = {
      brandProfile: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', ...profile }) },
    };
    return new BrandContextService(prisma as never);
  };

  it('includes each offering with its price', async () => {
    const svc = build({
      brandName: 'HummyTummy',
      offerings: [
        { name: 'Çekirdek', price: 'Ücretsiz', blurb: 'POS, KDS, QR menü' },
        { name: 'Ek Şube', price: '3.990₺/yıl' },
      ],
    });

    const block = await svc.summaryFor('ws1');

    expect(block).toContain('Ek Şube — 3.990₺/yıl');
    expect(block).toContain('Çekirdek — Ücretsiz — POS, KDS, QR menü');
  });

  it('keeps an offering that has no price rather than dropping it', async () => {
    const svc = build({ brandName: 'X', offerings: [{ name: 'Demo restoranı' }] });

    // "We have this, price unstated" is still worth knowing; silence is not.
    expect(await svc.summaryFor('ws1')).toContain('- Demo restoranı');
  });

  it('ignores malformed entries instead of rendering blanks', async () => {
    const svc = build({
      brandName: 'X',
      offerings: [{ name: '  ' }, { price: '10₺' }, null, { name: 'Gerçek' }],
    });

    const block = await svc.summaryFor('ws1');

    expect(block).toContain('- Gerçek');
    expect(block).not.toContain('- 10₺');
    expect(block!.split(String.fromCharCode(10)).filter((l) => l.startsWith('- '))).toHaveLength(1);
  });

  it('says nothing about offerings when there are none', async () => {
    const svc = build({ brandName: 'X', offerings: [] });

    expect(await svc.summaryFor('ws1')).not.toContain('Offerings');
  });
});
