import { ForbiddenException } from '@nestjs/common';
import { MarketingAuthService } from './marketing-auth.service';

/**
 * Billing is PER WORKSPACE — WorkspaceSubscription.workspaceId is unique — and
 * every workspace minted through self-serve lands on a free 14-day TRIAL with
 * its own 300 AI credits. The route carried no role gate, no count cap and no
 * rate limit by design ("ANY authenticated identity, in ANY role"), so one
 * sign-up could mint them in a loop: each a real trial, each able to spend our
 * vendor money, none of it billable.
 */
describe('MarketingAuthService.createOwnedWorkspace — ownership cap', () => {
  const ACTIVE_USER = { id: 'u1', status: 'ACTIVE', role: 'OWNER' };

  function svcWith(ownedCount: number) {
    const prisma = {
      marketingUser: { findUnique: jest.fn().mockResolvedValue(ACTIVE_USER), update: jest.fn() },
      workspaceMembership: { count: jest.fn().mockResolvedValue(ownedCount), create: jest.fn() },
      $transaction: jest.fn(),
    };
    const svc = new MarketingAuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma };
  }

  it('refuses once the identity is at the limit, before any provisioning', async () => {
    const { svc, prisma } = svcWith(5);
    await expect(
      svc.createOwnedWorkspace('u1', { workspaceName: 'Sixth brand' } as never),
    ).rejects.toThrow(ForbiddenException);

    // Nothing was scaffolded: no workspace row, no trial subscription.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('counts only ACTIVE OWNER memberships', async () => {
    const { svc, prisma } = svcWith(5);
    await expect(
      svc.createOwnedWorkspace('u1', { workspaceName: 'x' } as never),
    ).rejects.toThrow(ForbiddenException);

    // Being invited into somebody else's workspace as a REP is not ownership
    // and must not count against your own allowance.
    expect(prisma.workspaceMembership.count).toHaveBeenCalledWith({
      where: { userId: 'u1', role: 'OWNER', status: 'ACTIVE' },
    });
  });

  it('lets an identity under the limit through to provisioning', async () => {
    const { svc, prisma } = svcWith(2);
    prisma.$transaction.mockRejectedValue(new Error('stop here'));

    await expect(
      svc.createOwnedWorkspace('u1', { workspaceName: 'Second brand' } as never),
    ).rejects.toThrow('stop here');

    // Reached the scaffold — the cap is a ceiling, not a wall.
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('still refuses an inactive identity before counting anything', async () => {
    const { svc, prisma } = svcWith(0);
    prisma.marketingUser.findUnique.mockResolvedValue({ ...ACTIVE_USER, status: 'SUSPENDED' });

    await expect(svc.createOwnedWorkspace('u1', { workspaceName: 'x' } as never)).rejects.toThrow();
    expect(prisma.workspaceMembership.count).not.toHaveBeenCalled();
  });
});
