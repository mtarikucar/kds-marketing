import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesService } from './sites.service';

/**
 * `create` translates a duplicate-slug unique violation (SitePage is
 * @@unique([workspaceId, slug])) into a clean 400. `update` must do the same —
 * renaming a page's slug to one already taken otherwise threw a raw P2002 that
 * surfaced as an HTTP 500 with no actionable message.
 */
describe('SitesService.update — duplicate slug', () => {
  const mkPrisma = (updateImpl: () => Promise<unknown>) => ({
    sitePage: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p1', workspaceId: 'ws-1' }),
      update: jest.fn(updateImpl),
    },
  });
  const mkSvc = (prisma: unknown) =>
    new SitesService(
      prisma as never, null as never, null as never, null as never, null as never, null as never,
    );

  it('translates a duplicate-slug P2002 into a 400 (not a raw 500)', async () => {
    const prisma = mkPrisma(() =>
      Promise.reject(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })),
    );
    await expect(mkSvc(prisma).update('ws-1', 'p1', { slug: 'taken' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns the updated page on success', async () => {
    const updated = { id: 'p1', slug: 'fresh' };
    const prisma = mkPrisma(() => Promise.resolve(updated));
    await expect(mkSvc(prisma).update('ws-1', 'p1', { title: 'New' })).resolves.toEqual(updated);
  });

  it('rethrows a non-P2002 error unchanged', async () => {
    const boom = new Error('db down');
    const prisma = mkPrisma(() => Promise.reject(boom));
    await expect(mkSvc(prisma).update('ws-1', 'p1', { slug: 'x' })).rejects.toBe(boom);
  });
});

// A bare count-then-create lets two concurrent requests at (limit-1) BOTH pass the
// cap and exceed maxFunnels. create() serializes the check under a per-workspace
// advisory xact-lock (the ai-credits / message-quota / research quota pattern).
describe('SitesService.create — quota-race safety', () => {
  const WS = 'ws-1';
  function make(maxFunnels: number) {
    const prisma: any = {
      sitePage: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };
    const entitlements: any = { getEffective: jest.fn().mockResolvedValue({ limits: { maxFunnels } }) };
    const svc = new SitesService(
      prisma as never, entitlements as never, null as never, null as never, null as never, null as never,
    );
    return { prisma, svc };
  }

  it('serializes the count-check + create under a per-workspace advisory lock', async () => {
    const { prisma, svc } = make(5);
    prisma.sitePage.count.mockResolvedValue(4);
    await svc.create(WS, { title: 'Home' });
    expect(prisma.$transaction).toHaveBeenCalled();
    const lockSql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(lockSql).toContain('site-pages:ws-1');
    expect(prisma.sitePage.create).toHaveBeenCalled();
  });

  it('rejects at the cap without creating (checked inside the lock)', async () => {
    const { prisma, svc } = make(5);
    prisma.sitePage.count.mockResolvedValue(5);
    await expect(svc.create(WS, { title: 'Home' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.sitePage.create).not.toHaveBeenCalled();
  });

  it('skips the lock/count on an unlimited (-1) plan', async () => {
    const { prisma, svc } = make(-1);
    await svc.create(WS, { title: 'Home' });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.sitePage.create).toHaveBeenCalled();
  });
});

// Reference guards: deleting a page that a funnel step renders (or a form a
// page block references) silently broke LIVE surfaces mid-flow — the funnel
// 404ed at that step / the renderer dropped the form block with no warning.
describe('SitesService — delete reference guards', () => {
  const WS = 'ws-1';
  const mkSvc = (prisma: any) =>
    new SitesService(prisma as never, null as never, null as never, null as never, null as never, null as never);

  it('remove() refuses to delete a page referenced by a funnel step (409 with names)', async () => {
    const prisma: any = {
      funnel: {
        findMany: jest.fn().mockResolvedValue([
          { name: 'Demo funnel', steps: [{ sitePageId: 'p1' }] },
          { name: 'Other', steps: [{ sitePageId: 'p9' }] },
        ]),
      },
      sitePage: { deleteMany: jest.fn() },
    };
    await expect(mkSvc(prisma).remove(WS, 'p1')).rejects.toBeInstanceOf(ConflictException);
    await expect(mkSvc(prisma).remove(WS, 'p1')).rejects.toThrow(/Demo funnel/);
    expect(prisma.sitePage.deleteMany).not.toHaveBeenCalled();
  });

  it('remove() deletes an unreferenced page (404 when missing)', async () => {
    const prisma: any = {
      funnel: { findMany: jest.fn().mockResolvedValue([]) },
      sitePage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    await expect(mkSvc(prisma).remove(WS, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removeForm() refuses to delete a form still wired into a page block (409 with titles)', async () => {
    const prisma: any = {
      sitePage: {
        findMany: jest.fn().mockResolvedValue([
          { title: 'Landing', blocks: [{ type: 'form', formId: 'f1' }] },
          { title: 'About', blocks: [{ type: 'hero' }] },
        ]),
      },
      formDef: { deleteMany: jest.fn() },
    };
    await expect(mkSvc(prisma).removeForm(WS, 'f1')).rejects.toBeInstanceOf(ConflictException);
    await expect(mkSvc(prisma).removeForm(WS, 'f1')).rejects.toThrow(/Landing/);
    expect(prisma.formDef.deleteMany).not.toHaveBeenCalled();
  });

  it('removeForm() deletes an unreferenced form', async () => {
    const prisma: any = {
      sitePage: { findMany: jest.fn().mockResolvedValue([{ title: 'Landing', blocks: [{ type: 'hero' }] }]) },
      formDef: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    await expect(mkSvc(prisma).removeForm(WS, 'f1')).resolves.toEqual({ message: 'Form deleted' });
  });
});

/**
 * Final-review fix M2 — the public callback endpoint's opt-in gate + target
 * binding both hinge on this resolver: it must find a tenant-published
 * 'callback' block (never trusting visitor/request-body input for the
 * dial target) across both directly-published SitePages AND published
 * Funnels' step pages (whose underlying SitePage need not itself be
 * independently published).
 */
describe('SitesService.resolvePublicCallbackTarget', () => {
  const WS = 'ws-1';
  function make(prisma: any) {
    return new SitesService(prisma as never, null as never, null as never, null as never, null as never, null as never);
  }
  function basePrisma(overrides: any = {}) {
    return {
      sitePage: {
        findMany: jest.fn().mockResolvedValue([]),
        ...overrides.sitePage,
      },
      funnel: {
        findMany: jest.fn().mockResolvedValue([]),
        ...overrides.funnel,
      },
    };
  }

  it('returns null when no published SitePage or Funnel has a callback block', async () => {
    const prisma = basePrisma();
    const svc = make(prisma);
    await expect(svc.resolvePublicCallbackTarget(WS)).resolves.toBeNull();
    expect(prisma.sitePage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, published: true } }),
    );
  });

  it('finds a callback block directly on a published SitePage', async () => {
    const prisma = basePrisma({
      sitePage: {
        findMany: jest.fn().mockResolvedValue([{ blocks: [{ type: 'callback', redirectMenu: '850-queue-vip', redirectType: 'ivr' }] }]),
      },
    });
    const svc = make(prisma);
    await expect(svc.resolvePublicCallbackTarget(WS)).resolves.toEqual({
      redirectMenu: '850-queue-vip',
      redirectType: 'ivr',
    });
    // A hit on a directly-published page short-circuits — no need to also query funnels.
    expect(prisma.funnel.findMany).not.toHaveBeenCalled();
  });

  it('defaults an invalid/missing redirectType to "queue"', async () => {
    const prisma = basePrisma({
      sitePage: { findMany: jest.fn().mockResolvedValue([{ blocks: [{ type: 'callback', redirectMenu: 'q1', redirectType: 'bogus' }] }]) },
    });
    const svc = make(prisma);
    await expect(svc.resolvePublicCallbackTarget(WS)).resolves.toEqual({ redirectMenu: 'q1', redirectType: 'queue' });
  });

  it('ignores a callback block with an empty/missing redirectMenu (not eligible)', async () => {
    const prisma = basePrisma({
      sitePage: { findMany: jest.fn().mockResolvedValue([{ blocks: [{ type: 'callback', redirectMenu: '   ' }] }]) },
    });
    const svc = make(prisma);
    await expect(svc.resolvePublicCallbackTarget(WS)).resolves.toBeNull();
  });

  it('falls back to a published Funnel step page when no directly-published SitePage has one — the step page itself need not be published', async () => {
    const prisma = basePrisma({
      sitePage: {
        findMany: jest
          .fn()
          // 1st call: directly-published pages — none eligible.
          .mockResolvedValueOnce([{ blocks: [{ type: 'hero', heading: 'x' }] }])
          // 2nd call: the funnel step's page (fetched by id, published-agnostic).
          .mockResolvedValueOnce([{ blocks: [{ type: 'callback', redirectMenu: 'funnel-queue', redirectType: 'announcement' }] }]),
      },
      funnel: {
        findMany: jest.fn().mockResolvedValue([{ steps: [{ sitePageId: 'step-page-1' }] }]),
      },
    });
    const svc = make(prisma);
    await expect(svc.resolvePublicCallbackTarget(WS)).resolves.toEqual({
      redirectMenu: 'funnel-queue',
      redirectType: 'announcement',
    });
    expect(prisma.sitePage.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { workspaceId: WS, id: { in: ['step-page-1'] } } }),
    );
  });

  it('returns null when funnels exist but none reference a page with a callback block', async () => {
    const prisma = basePrisma({
      sitePage: {
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ blocks: [{ type: 'hero' }] }]),
      },
      funnel: { findMany: jest.fn().mockResolvedValue([{ steps: [{ sitePageId: 'step-page-1' }] }]) },
    });
    const svc = make(prisma);
    await expect(svc.resolvePublicCallbackTarget(WS)).resolves.toBeNull();
  });
});
