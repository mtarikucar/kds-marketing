import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkspacesAdminService } from './workspaces-admin.service';

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
  };
  return { prisma, svc: new WorkspacesAdminService(prisma as any) };
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
