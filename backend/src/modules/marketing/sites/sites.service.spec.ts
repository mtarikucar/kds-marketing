import { BadRequestException } from '@nestjs/common';
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
