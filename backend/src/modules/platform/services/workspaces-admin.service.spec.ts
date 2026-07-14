import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkspacesAdminService } from './workspaces-admin.service';

function makeSvc() {
  const prisma: any = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'ws-1', kind: 'AGENCY' }),
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
});
