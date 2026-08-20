import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SocialPlannerService } from './social-planner.service';

/**
 * Disconnecting used to be a bare `socialAccount.delete`. SocialPostTarget
 * references the account with `onDelete: Restrict` — correctly, since publish
 * history and its metrics must outlive a disconnect — so the database refused
 * the delete for any account that had ever published, and the raw foreign-key
 * error reached the user as an opaque failure.
 *
 * The practical effect: an account could be disconnected until its first post,
 * and never again. Reported live against a broken Instagram record that had 4
 * targets on it (2 published, 2 failed).
 */
describe('SocialPlannerService.disconnectAccount', () => {
  const WS = 'ws-1';
  const ID = 'acct-1';
  let prisma: any;
  let svc: SocialPlannerService;

  const fkError = () =>
    new Prisma.PrismaClientKnownRequestError('FK', { code: 'P2003', clientVersion: 'x' });

  beforeEach(() => {
    prisma = {
      socialAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: ID, network: 'INSTAGRAM' }),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      socialPostTarget: { count: jest.fn().mockResolvedValue(0) },
    };
    svc = new SocialPlannerService(
      prisma,
      ...(Array(12).fill({}) as never[]),
    );
  });

  it('deletes outright when the account never published', async () => {
    const out = await svc.disconnectAccount(WS, ID);
    expect(prisma.socialAccount.delete).toHaveBeenCalled();
    expect(out).toMatchObject({ disconnected: true, deleted: true, postsKept: 0 });
  });

  it('revokes instead of deleting when posts reference it, and keeps them', async () => {
    prisma.socialPostTarget.count.mockResolvedValue(4);

    const out = await svc.disconnectAccount(WS, ID);

    expect(prisma.socialAccount.delete).not.toHaveBeenCalled();
    expect(out).toMatchObject({ disconnected: true, deleted: false, postsKept: 4 });
  });

  it('empties the tokens — that is what makes it a disconnect', async () => {
    prisma.socialPostTarget.count.mockResolvedValue(4);
    await svc.disconnectAccount(WS, ID);

    // Every publish path opens accessToken; with it gone there is nothing left
    // to post as this account with, which is the whole point.
    expect(prisma.socialAccount.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: expect.objectContaining({
        accessToken: '',
        refreshToken: null,
        tokenExpiresAt: null,
        enabled: false,
        lastError: 'disconnected',
      }),
    });
  });

  it('falls back to revoke if a target appears between the count and the delete', async () => {
    prisma.socialPostTarget.count.mockResolvedValue(0);
    prisma.socialAccount.delete.mockRejectedValue(fkError());

    const out = await svc.disconnectAccount(WS, ID);

    // The race must not hand the user the foreign-key error that started this.
    expect(prisma.socialAccount.update).toHaveBeenCalled();
    expect(out.disconnected).toBe(true);
  });

  it('rethrows a delete failure that is not the FK constraint', async () => {
    prisma.socialAccount.delete.mockRejectedValue(new Error('connection lost'));
    await expect(svc.disconnectAccount(WS, ID)).rejects.toThrow('connection lost');
    expect(prisma.socialAccount.update).not.toHaveBeenCalled();
  });

  it('scopes the reference count to the workspace too', async () => {
    await svc.disconnectAccount(WS, ID);
    expect(prisma.socialPostTarget.count).toHaveBeenCalledWith({
      where: { socialAccountId: ID, workspaceId: WS },
    });
  });

  it('scopes to the caller workspace', async () => {
    prisma.socialAccount.findFirst.mockResolvedValue(null);
    await expect(svc.disconnectAccount(WS, ID)).rejects.toThrow(NotFoundException);
    expect(prisma.socialAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, workspaceId: WS } }),
    );
  });
});
