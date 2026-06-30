import { ConflictException, NotFoundException } from '@nestjs/common';
import { CommunitiesService } from './communities.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new CommunitiesService(prisma as any) };
}

describe('CommunitiesService', () => {
  it('creates a community with a slug and rejects duplicates', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findUnique.mockResolvedValue(null as any);
    (prisma.community.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'co1', ...a.data }));
    const out: any = await svc.create(WS, { name: 'Coffee Club' });
    expect(out.slug).toBe('coffee-club');

    prisma.community.findUnique.mockResolvedValue({ id: 'co1' } as any);
    await expect(svc.create(WS, { name: 'Coffee Club' })).rejects.toBeInstanceOf(ConflictException);
  });

  // The dup pre-check is a TOCTOU window — two concurrent same-slug creates both
  // pass findUnique, the 2nd insert trips the (workspaceId, slug) unique → P2002.
  // Map it to a clean 409, not a raw 500 (no global Prisma→HTTP mapping).
  it('maps a P2002 race on create to a 409', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findUnique.mockResolvedValue(null as any); // pre-check passes
    (prisma.community.create as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(svc.create(WS, { name: 'Coffee Club' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('join is idempotent (upsert keyed on community+lead)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as any);
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.communityMember.upsert as jest.Mock).mockResolvedValue({ id: 'mem1' });
    await svc.join(WS, 'co1', 'lead-1');
    expect((prisma.communityMember.upsert as jest.Mock).mock.calls[0][0].where).toEqual({
      communityId_leadId: { communityId: 'co1', leadId: 'lead-1' },
    });
  });

  it('404s joining a lead that belongs to another workspace (no cross-tenant join)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    await expect(svc.join(WS, 'co1', 'foreign-lead')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.communityMember.upsert).not.toHaveBeenCalled();
  });

  it('creates a post under a community', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as any);
    (prisma.communityPost.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'p1', ...a.data }));
    const out: any = await svc.createPost(WS, 'co1', { body: 'hello' }, 'user-1');
    expect(out).toMatchObject({ communityId: 'co1', workspaceId: WS, authorUserId: 'user-1', body: 'hello' });
  });

  it('lists posts pinned-first, newest-first', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as any);
    (prisma.communityPost.findMany as jest.Mock).mockResolvedValue([]);
    await svc.listPosts(WS, 'co1');
    const arg = (prisma.communityPost.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.orderBy).toEqual([{ pinned: 'desc' }, { createdAt: 'desc' }]);
  });

  // The controller passes parseInt(page) — a non-numeric ?page=abc yields NaN.
  // Math.max(1, NaN) is NaN, so `skip` became NaN and Prisma threw a 500. A bad
  // page param must degrade to the first page, not crash.
  it('defaults a NaN page to the first page (skip 0, no 500)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as any);
    (prisma.communityPost.findMany as jest.Mock).mockResolvedValue([]);
    await svc.listPosts(WS, 'co1', Number.NaN);
    const arg = (prisma.communityPost.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.skip).toBe(0);
  });

  it('paginates a valid page (skip = (page-1)*pageSize)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as any);
    (prisma.communityPost.findMany as jest.Mock).mockResolvedValue([]);
    await svc.listPosts(WS, 'co1', 3);
    const arg = (prisma.communityPost.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.skip).toBe(40);
  });

  it('adds a comment after asserting the post is in the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.communityPost.findFirst.mockResolvedValue({ id: 'p1' } as any);
    (prisma.communityComment.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'cm1', ...a.data }));
    const out: any = await svc.addComment(WS, 'p1', 'nice', 'user-1');
    expect(out).toMatchObject({ postId: 'p1', body: 'nice' });
  });

  it('404s commenting on a post from another workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.communityPost.findFirst.mockResolvedValue(null as any);
    await expect(svc.addComment(WS, 'ghost', 'x', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
