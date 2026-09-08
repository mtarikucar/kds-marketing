import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContentTypesService, typeGuidanceLines } from './content-types.service';
import { DEFAULT_CONTENT_TYPES } from './content-types.seed';

const WS = 'ws-1';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ct-1', workspaceId: WS, key: 'how-to', name: 'Nasıl yapılır', description: 'd',
    structure: [{ role: 'hook', durationSec: 3, guidance: 'g' }], defaultDurationSec: 3,
    networks: ['INSTAGRAM'], minShare: 0.05, maxShare: 0.4, active: true, isSeed: true, ordinal: 1,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

function harness() {
  const prisma: any = {
    contentType: {
      createMany: jest.fn().mockResolvedValue({ count: 10 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: any) => row({ id: 'ct-new', ...data })),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => row({ ...where, ...data })),
    },
  };
  return { svc: new ContentTypesService(prisma), prisma };
}

describe('DEFAULT_CONTENT_TYPES', () => {
  it('ships the ten agreed formats, ordinals 0..9, every structure summing to its default duration', () => {
    expect(DEFAULT_CONTENT_TYPES.map((t) => t.key)).toEqual([
      'hook-story', 'how-to', 'before-after', 'pov-ugc', 'product-demo',
      'myth-bust', 'listicle', 'behind-the-scenes', 'testimonial', 'trend-remix',
    ]);
    DEFAULT_CONTENT_TYPES.forEach((t, i) => {
      expect(t.ordinal).toBe(i);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.structure.length).toBeGreaterThanOrEqual(3);
      expect(t.structure.length).toBeLessThanOrEqual(4);
      expect(t.structure.reduce((s, b) => s + b.durationSec, 0)).toBe(t.defaultDurationSec);
      expect(t.defaultDurationSec).toBeGreaterThanOrEqual(12);
      expect(t.defaultDurationSec).toBeLessThanOrEqual(20);
      expect(t.minShare).toBe(0.05);
      expect(t.maxShare).toBe(t.key === 'trend-remix' ? 0.25 : 0.4);
      expect(t.networks).toEqual(expect.arrayContaining(['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK']));
    });
    expect(DEFAULT_CONTENT_TYPES.find((t) => t.key === 'testimonial')!.networks).toContain('LINKEDIN');
  });
});

describe('ContentTypesService.ensureDefaults', () => {
  it('copies the seed with skipDuplicates (idempotent) and returns the workspace list ordered by ordinal', async () => {
    const { svc, prisma } = harness();
    const rows = DEFAULT_CONTENT_TYPES.map((t) => row({ id: `ct-${t.ordinal}`, key: t.key, ordinal: t.ordinal }));
    prisma.contentType.findMany.mockResolvedValue(rows);
    const out = await svc.ensureDefaults(WS);
    expect(prisma.contentType.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: expect.arrayContaining([expect.objectContaining({ workspaceId: WS, key: 'hook-story', isSeed: true, ordinal: 0 })]),
    }));
    expect(prisma.contentType.createMany.mock.calls[0][0].data).toHaveLength(10);
    expect(prisma.contentType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS }, orderBy: { ordinal: 'asc' } }));
    expect(out).toHaveLength(10);
    // A second call inserts nothing new (skipDuplicates) and still returns the rows.
    prisma.contentType.createMany.mockResolvedValue({ count: 0 });
    expect(await svc.ensureDefaults(WS)).toHaveLength(10);
  });
});

describe('ContentTypesService.list', () => {
  it('orders by ordinal, scopes to the workspace, and filters active on request', async () => {
    const { svc, prisma } = harness();
    await svc.list(WS);
    expect(prisma.contentType.findMany).toHaveBeenCalledWith({ where: { workspaceId: WS }, orderBy: { ordinal: 'asc' } });
    await svc.list(WS, { activeOnly: true });
    expect(prisma.contentType.findMany).toHaveBeenLastCalledWith({ where: { workspaceId: WS, active: true }, orderBy: { ordinal: 'asc' } });
  });
});

describe('ContentTypesService.create', () => {
  it('creates an owner-defined (non-seed) type after the seeds, stamped with the workspace', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findMany.mockResolvedValue([row({ ordinal: 9 })]);
    const out = await svc.create(WS, {
      key: 'unboxing', name: 'Kutu açılışı', structure: [{ role: 'open', durationSec: 5, guidance: 'g' }, { role: 'reveal', durationSec: 7, guidance: 'g' }],
    });
    expect(prisma.contentType.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workspaceId: WS, key: 'unboxing', name: 'Kutu açılışı', isSeed: false, ordinal: 10, defaultDurationSec: 12, minShare: 0.05, maxShare: 0.4, networks: [],
    }) });
    expect(out.key).toBe('unboxing');
  });

  it('rejects a bad slug, an empty name, inverted or out-of-range shares, and a malformed structure', async () => {
    const { svc, prisma } = harness();
    const ok = { key: 'ok-key', name: 'n' };
    await expect(svc.create(WS, { ...ok, key: 'Bad Key' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, key: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, minShare: 0.5, maxShare: 0.3 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, maxShare: 1.2 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, minShare: -0.1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, structure: 'hook' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, structure: [{ role: 'hook', durationSec: 0, guidance: 'g' }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, structure: [{ role: '', durationSec: 3, guidance: 'g' }] as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(WS, { ...ok, networks: ['MYSPACE'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contentType.create).not.toHaveBeenCalled();
  });

  it('refuses a key the workspace already uses', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findFirst.mockResolvedValue(row({ key: 'how-to' }));
    await expect(svc.create(WS, { key: 'how-to', name: 'n' })).rejects.toThrow(/already/);
    expect(prisma.contentType.findFirst).toHaveBeenCalledWith({ where: { workspaceId: WS, key: 'how-to' } });
  });
});

describe('ContentTypesService.update', () => {
  it('patches settings on the workspace-owned row and keeps the key immutable', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findFirst.mockResolvedValue(row());
    await svc.update(WS, 'ct-1', { name: 'Yeni ad', active: false, maxShare: 0.3 });
    expect(prisma.contentType.findFirst).toHaveBeenCalledWith({ where: { id: 'ct-1', workspaceId: WS } });
    expect(prisma.contentType.update).toHaveBeenCalledWith({ where: { id: 'ct-1' }, data: { name: 'Yeni ad', active: false, maxShare: 0.3 } });
    await expect(svc.update(WS, 'ct-1', { key: 'other' } as any)).rejects.toThrow(/key/);
  });

  it('checks shares against the stored counterpart, so a lone minShare cannot climb over maxShare', async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findFirst.mockResolvedValue(row({ minShare: 0.1, maxShare: 0.3 }));
    await expect(svc.update(WS, 'ct-1', { minShare: 0.35 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(WS, 'ct-1', { maxShare: 0.05 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(WS, 'ct-1', { name: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(WS, 'ct-1', { structure: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contentType.update).not.toHaveBeenCalled();
    await svc.update(WS, 'ct-1', { minShare: 0.2 });
    expect(prisma.contentType.update).toHaveBeenCalledWith({ where: { id: 'ct-1' }, data: { minShare: 0.2 } });
  });

  it("is NotFound for another workspace's row", async () => {
    const { svc, prisma } = harness();
    prisma.contentType.findFirst.mockResolvedValue(null);
    await expect(svc.update(WS, 'ct-foreign', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contentType.findFirst).toHaveBeenCalledWith({ where: { id: 'ct-foreign', workspaceId: WS } });
  });
});

describe('typeGuidanceLines', () => {
  it('renders name, description, total duration and each beat with its time window', () => {
    const lines = typeGuidanceLines({
      name: 'Nasıl yapılır', description: 'Üç adımda.', defaultDurationSec: 10,
      structure: [
        { role: 'hook', durationSec: 3, guidance: 'Sonucu göster.' },
        { role: 'step', durationSec: 7, guidance: 'Adımı göster.' },
      ],
    });
    expect(lines).toEqual([
      'İçerik tipi: Nasıl yapılır — Üç adımda.',
      'Toplam süre: 10 s, 2 beat.',
      'beat 1 (0-3s): hook — Sonucu göster.',
      'beat 2 (3-10s): step — Adımı göster.',
    ]);
  });

  it('survives a malformed structure column and an empty description', () => {
    expect(typeGuidanceLines({ name: 'X', description: '', defaultDurationSec: 15, structure: 'junk' as any })).toEqual([
      'İçerik tipi: X',
      'Toplam süre: 15 s.',
    ]);
  });
});
