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
