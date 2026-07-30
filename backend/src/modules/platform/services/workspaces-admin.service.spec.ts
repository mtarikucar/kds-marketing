import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkspacesAdminService } from './workspaces-admin.service';
import { INTERNAL_GRANT_PERIOD_END } from '../../billing/package-assignment';

function makeSvc() {
  const prisma: any = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ id: 'ws-1', kind: 'STANDALONE' }),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'ws-1', kind: 'AGENCY' }),
    },
    marketingUser: {
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    package: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'pkg-op',
        code: 'OPERATOR',
        name: 'Operator (internal)',
        dailyLeadQuota: -1,
        maxUsers: -1,
        maxResearchProfiles: -1,
        limits: { aiCreditsMonthly: -1 },
      }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ code: 'TRIAL' }, { code: 'STARTER' }, { code: 'OPERATOR' }]),
    },
    workspaceSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const entitlements: any = { invalidate: jest.fn() };
  return { prisma, entitlements, svc: new WorkspacesAdminService(prisma as any, entitlements) };
}

describe('WorkspacesAdminService.update — workspace tier (agency designation)', () => {
  it('promotes a STANDALONE workspace to AGENCY (unlocking the agency console)', async () => {
    const { prisma, svc } = makeSvc();
    await svc.update('ws-1', { kind: 'AGENCY' } as any);
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ws-1' }, data: expect.objectContaining({ kind: 'AGENCY' }) }),
    );
    // Promotion never checks for children.
    expect(prisma.workspace.count).not.toHaveBeenCalled();
  });

  it('refuses to demote an AGENCY that still has sub-accounts (would orphan them)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.count.mockResolvedValue(2); // has 2 child LOCATIONs
    await expect(svc.update('ws-1', { kind: 'STANDALONE' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workspace.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { parentWorkspaceId: 'ws-1', kind: 'LOCATION' } }),
    );
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('allows demoting an AGENCY with no sub-accounts', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.count.mockResolvedValue(0);
    await svc.update('ws-1', { kind: 'STANDALONE' } as any);
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'STANDALONE' }) }),
    );
  });

  it('404s for a missing workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(svc.update('ghost', { name: 'X' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses ANY tier change on a LOCATION sub-account (its tier belongs to the parent agency)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue({ id: 'loc-1', kind: 'LOCATION' });
    await expect(svc.update('loc-1', { kind: 'AGENCY' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('loc-1', { kind: 'STANDALONE' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('still allows non-tier edits (e.g. rename) on a LOCATION', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue({ id: 'loc-1', kind: 'LOCATION' });
    await svc.update('loc-1', { name: 'Renamed' } as any);
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Renamed' }) }),
    );
  });
});

describe('WorkspacesAdminService.updateStatus — suspension takes effect immediately', () => {
  it('SUSPENDED bumps every user tokenVersion (revokes in-flight access tokens now, not at 8h expiry)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.update.mockResolvedValue({ id: 'ws-1', slug: 's', name: 'W', status: 'SUSPENDED' });
    await svc.updateStatus('ws-1', 'SUSPENDED');
    expect(prisma.marketingUser.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it('re-ACTIVATING does not churn tokenVersion (users simply log in again)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.update.mockResolvedValue({ id: 'ws-1', slug: 's', name: 'W', status: 'ACTIVE' });
    await svc.updateStatus('ws-1', 'ACTIVE');
    expect(prisma.marketingUser.updateMany).not.toHaveBeenCalled();
  });
});

describe('WorkspacesAdminService.assignPackage — operator package grant', () => {
  it('upserts the subscription and returns the effective grant', async () => {
    const { prisma, entitlements, svc } = makeSvc();
    const result = await svc.assignPackage('ws-1', 'OPERATOR');

    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws-1' },
        update: expect.objectContaining({
          packageId: 'pkg-op',
          status: 'ACTIVE',
          trialEndsAt: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: INTERNAL_GRANT_PERIOD_END,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        workspaceId: 'ws-1',
        packageCode: 'OPERATOR',
        status: 'ACTIVE',
        changed: true,
      }),
    );
    expect(result.limits).toEqual(
      expect.objectContaining({ dailyLeadQuota: -1, aiCreditsMonthly: -1 }),
    );
    // The 30s entitlement cache would otherwise keep serving the old plan.
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
  });

  it('is idempotent — assigning the same package twice writes once', async () => {
    const { prisma, svc } = makeSvc();
    await svc.assignPackage('ws-1', 'OPERATOR');
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      packageId: 'pkg-op',
      status: 'ACTIVE',
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(INTERNAL_GRANT_PERIOD_END),
    });
    const second = await svc.assignPackage('ws-1', 'OPERATOR');

    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledTimes(1);
    expect(second.changed).toBe(false);
    expect(second.packageCode).toBe('OPERATOR');
  });

  it('400s on an unknown package code, listing the valid ones', async () => {
    const { prisma, svc } = makeSvc();
    prisma.package.findUnique.mockResolvedValue(null);
    await expect(svc.assignPackage('ws-1', 'PLATINUM')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.assignPackage('ws-1', 'PLATINUM')).rejects.toThrow(
      /TRIAL, STARTER, OPERATOR/,
    );
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('404s on an unknown workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(svc.assignPackage('ghost', 'OPERATOR')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('normalises the code (trim + upper) so "operator " still resolves', async () => {
    const { prisma, svc } = makeSvc();
    await svc.assignPackage('ws-1', ' operator ');
    expect(prisma.package.findUnique).toHaveBeenCalledWith({
      where: { code: 'OPERATOR' },
    });
  });
});
