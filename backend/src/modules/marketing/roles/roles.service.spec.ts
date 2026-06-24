import { BadRequestException, ConflictException } from '@nestjs/common';
import { RolesService } from './roles.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new RolesService(prisma as any) };
}

describe('RolesService', () => {
  it('rejects unknown permissions and duplicate names on create', async () => {
    const { prisma, svc } = makeSvc();
    await expect(svc.create(WS, { name: 'X', permissions: ['bogus.perm'] })).rejects.toBeInstanceOf(BadRequestException);

    prisma.customRole.findUnique.mockResolvedValue({ id: 'r1' } as any);
    await expect(svc.create(WS, { name: 'X', permissions: ['leads.read'] })).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolves a custom role permission set when assigned', async () => {
    const { prisma, svc } = makeSvc();
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['leads.read', 'reports.read'] } as any);
    const perms = await svc.resolvePermissions({ workspaceId: 'ws-1', role: 'REP', customRoleId: 'r1' });
    expect(perms).toEqual(['leads.read', 'reports.read']);
    expect(await svc.hasPermission({ workspaceId: 'ws-1', role: 'REP', customRoleId: 'r1' }, 'reports.read')).toBe(true);
    expect(await svc.hasPermission({ workspaceId: 'ws-1', role: 'REP', customRoleId: 'r1' }, 'billing.manage')).toBe(false);
    // The custom-role read is workspace-scoped.
    expect(prisma.customRole.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'r1', workspaceId: 'ws-1' });
  });

  it('falls back to the legacy role mapping when no custom role', async () => {
    const { svc } = makeSvc();
    expect(await svc.hasPermission({ workspaceId: 'ws-1', role: 'OWNER' }, 'billing.manage')).toBe(true);
    expect(await svc.hasPermission({ workspaceId: 'ws-1', role: 'REP' }, 'billing.manage')).toBe(false);
    expect(await svc.hasPermission({ workspaceId: 'ws-1', role: 'REP' }, 'leads.write')).toBe(true);
  });

  it('assignToUser validates the user + role belong to the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'u1' } as any);
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out = await svc.assignToUser(WS, 'u1', 'r1');
    expect(out).toEqual({ userId: 'u1', customRoleId: 'r1' });
  });
});
