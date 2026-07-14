import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageFunnelsService } from './page-funnels.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    funnel: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'fn1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sitePage: { findFirst: jest.fn() },
    formDef: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const renderer = { render: jest.fn().mockReturnValue('<html><body>PAGE</body></html>') };
  const branding = { get: jest.fn().mockResolvedValue(undefined) };
  const svc = new PageFunnelsService(prisma as any, renderer as any, branding as any);
  return { svc, prisma, renderer };
}

describe('PageFunnelsService', () => {
  it('creates a funnel, deriving + validating the slug and normalizing steps', async () => {
    const { svc, prisma } = makeSvc();
    await svc.create(WS, { name: 'My Funnel!', steps: [{ sitePageId: 'p1', name: 'Step 1' }, { sitePageId: '' } as any] });
    const data = prisma.funnel.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe(WS);
    expect(data.slug).toBe('my-funnel');
    expect(data.steps).toEqual([{ sitePageId: 'p1', name: 'Step 1' }]); // empty-sitePageId step dropped
  });

  it('derives a usable slug from a single-char and a Turkish name (no 400)', async () => {
    const { svc, prisma } = makeSvc();
    await svc.create(WS, { name: 'X' });
    expect(prisma.funnel.create.mock.calls[0][0].data.slug).toBe('x');
    await svc.create(WS, { name: 'Çağrı Hunisi' });
    const slug = prisma.funnel.create.mock.calls[1][0].data.slug;
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/); // a usable slug, never empty / never 400
    expect(slug.length).toBeGreaterThan(0);
  });

  it('maps a slug collision to a 400', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6' }));
    await expect(svc.create(WS, { name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses publishing a funnel with ZERO steps (its public URL is a guaranteed 404)', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', workspaceId: WS, published: false, steps: [] });
    await expect(svc.update(WS, 'fn1', { published: true })).rejects.toThrow(/at least one step/);
    expect(prisma.funnel.updateMany).not.toHaveBeenCalled();
  });

  it('refuses emptying the steps of an already-published funnel (effective post-update state)', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', workspaceId: WS, published: true, steps: [{ sitePageId: 'p1' }] });
    await expect(svc.update(WS, 'fn1', { steps: [] })).rejects.toThrow(/at least one step/);
  });

  it('allows publishing WITH steps, and unpublishing an empty funnel', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', workspaceId: WS, published: false, steps: [{ sitePageId: 'p1' }] });
    await expect(svc.update(WS, 'fn1', { published: true })).resolves.toBeDefined();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn2', workspaceId: WS, published: true, steps: [] });
    await expect(svc.update(WS, 'fn2', { published: false, steps: [] })).resolves.toBeDefined();
  });

  it('render returns null for an unknown/unpublished funnel', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue(null);
    expect(await svc.render(WS, 'slug', 0, 'https://m')).toBeNull();
    expect(prisma.funnel.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, slug: 'slug', published: true });
  });

  it('render returns null for an out-of-range step', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', steps: [{ sitePageId: 'p1' }] });
    expect(await svc.render(WS, 'slug', 5, 'https://m')).toBeNull();
  });

  it('render reuses the renderer and appends a Continue link when a next step exists', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', steps: [{ sitePageId: 'p1' }, { sitePageId: 'p2' }] });
    prisma.sitePage.findFirst.mockResolvedValue({ id: 'p1', workspaceId: WS, title: 'T', blocks: [] });
    const html = await svc.render(WS, 'slug', 0, 'https://m.example/');
    expect(html).toContain('PAGE');
    expect(html).toContain('/api/public/funnel/ws-1/slug/1');
    expect(html).toContain('Continue');
  });

  it('render does NOT append Continue on the last step', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', steps: [{ sitePageId: 'p1' }] });
    prisma.sitePage.findFirst.mockResolvedValue({ id: 'p1', workspaceId: WS, title: 'T', blocks: [] });
    const html = await svc.render(WS, 'slug', 0, 'https://m');
    expect(html).not.toContain('Continue');
  });

  it('render 404s (null) when the step references a missing page', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue({ id: 'fn1', steps: [{ sitePageId: 'gone' }] });
    prisma.sitePage.findFirst.mockResolvedValue(null);
    expect(await svc.render(WS, 'slug', 0, 'https://m')).toBeNull();
  });

  it('update 404s an unknown funnel', async () => {
    const { svc, prisma } = makeSvc();
    prisma.funnel.findFirst.mockResolvedValue(null);
    await expect(svc.update(WS, 'fn1', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
