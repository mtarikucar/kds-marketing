import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RolesService } from './roles.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const OWNER = { workspaceId: WS, role: 'OWNER' };
const MANAGER = { workspaceId: WS, role: 'MANAGER' };

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new RolesService(prisma as any) };
}

describe('RolesService', () => {
  it('rejects unknown permissions and duplicate names on create', async () => {
    const { prisma, svc } = makeSvc();
    await expect(svc.create(WS, { name: 'X', permissions: ['bogus.perm'] }, OWNER)).rejects.toBeInstanceOf(BadRequestException);

    prisma.customRole.findUnique.mockResolvedValue({ id: 'r1' } as any);
    await expect(svc.create(WS, { name: 'X', permissions: ['leads.read'] }, OWNER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects granting a permission the actor does not hold (no MANAGER self-escalation)', async () => {
    const { svc } = makeSvc();
    // MANAGER lacks billing.manage + users.manage — cannot mint a role that grants them.
    await expect(
      svc.create(WS, { name: 'Super', permissions: ['leads.read', 'billing.manage'] }, MANAGER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.create(WS, { name: 'Super', permissions: ['users.manage'] }, MANAGER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the actor grant permissions within their own set', async () => {
    const { prisma, svc } = makeSvc();
    prisma.customRole.findUnique.mockResolvedValue(null as any); // no dupe
    (prisma.customRole.create as jest.Mock).mockResolvedValue({ id: 'r9', name: 'Helper' });
    const out: any = await svc.create(WS, { name: 'Helper', permissions: ['leads.read', 'reports.read'] }, MANAGER);
    expect(out).toMatchObject({ id: 'r9' });
  });

  it('OWNER can grant any permission (full set)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.customRole.findUnique.mockResolvedValue(null as any);
    (prisma.customRole.create as jest.Mock).mockResolvedValue({ id: 'r10' });
    const out: any = await svc.create(WS, { name: 'Admin', permissions: ['billing.manage', 'users.manage'] }, OWNER);
    expect(out).toMatchObject({ id: 'r10' });
  });

  it('assignToUser refuses a role more powerful than the actor', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'u1' } as any);
    // the target role grants billing.manage, which a MANAGER actor does not hold
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['billing.manage'] } as any);
    await expect(svc.assignToUser(WS, 'u1', 'r1', MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('assignToUser refuses to modify a user more powerful than the actor (no OWNER lock-out)', async () => {
    const { prisma, svc } = makeSvc();
    // Target is an OWNER (holds billing.manage / users.manage a MANAGER lacks).
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'owner-1', role: 'OWNER', customRoleId: null } as any);
    // Even a harmless weak role must be refused — assigning it would REPLACE the
    // OWNER's legacy permissions, downgrading + locking them out of settings.
    prisma.customRole.findFirst.mockResolvedValue({ id: 'weak', permissions: ['leads.read'] } as any);
    await expect(svc.assignToUser(WS, 'owner-1', 'weak', MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
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

  // Privilege-floor guard parity: update() and assignToUser() refuse to touch a
  // target holding permissions the actor lacks, but remove() deleted any role
  // unconditionally — and deleting unassigns every holder (→ legacy perms),
  // downgrading users a superior elevated via a custom role. A MANAGER must not
  // be able to delete an OWNER-level role.
  it('remove refuses to delete a role more powerful than the actor', async () => {
    const { prisma, svc } = makeSvc();
    // The role grants billing.manage, which a MANAGER actor does not hold.
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['billing.manage'] } as any);
    await expect((svc.remove as any)(WS, 'r1', MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    // It must not have unassigned holders or deleted the role.
    expect(prisma.marketingUser.updateMany).not.toHaveBeenCalled();
    expect(prisma.customRole.delete).not.toHaveBeenCalled();
  });

  it('remove lets the actor delete a role within their grant', async () => {
    const { prisma, svc } = makeSvc();
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r2', permissions: ['leads.read'] } as any);
    (prisma.marketingUser.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.customRole.delete as jest.Mock).mockResolvedValue({ id: 'r2' });
    const out = await (svc.remove as any)(WS, 'r2', MANAGER);
    expect(out).toEqual({ id: 'r2' });
    expect(prisma.customRole.delete).toHaveBeenCalledWith({ where: { id: 'r2' } });
  });

  // P2002 parity with create()'s pre-check: a unique (workspaceId,name) collision
  // — a create race, or an update renaming a role onto a taken name — must surface
  // as a clean 409, not a raw PrismaClientKnownRequestError → 500.
  it('create surfaces a name-collision race as a 409 (not a raw 500)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.customRole.findUnique.mockResolvedValue(null as any); // pre-check passes…
    // …but a concurrent creator wins the unique index between check and insert.
    (prisma.customRole.create as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(
      svc.create(WS, { name: 'Dup', permissions: ['leads.read'] }, OWNER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update surfaces a rename collision as a 409 (not a raw 500)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['leads.read'] } as any);
    (prisma.customRole.update as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(svc.update(WS, 'r1', { name: 'Taken' }, OWNER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('assignToUser validates the user + role belong to the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'u1' } as any);
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['leads.read'] } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out = await svc.assignToUser(WS, 'u1', 'r1', OWNER);
    expect(out).toEqual({ userId: 'u1', customRoleId: 'r1' });
  });
});
