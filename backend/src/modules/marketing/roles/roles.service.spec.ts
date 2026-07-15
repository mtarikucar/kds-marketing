import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: undefined, customRoleId: undefined } as any);
    // the target role grants billing.manage, which a MANAGER actor does not hold
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['billing.manage'] } as any);
    await expect(svc.assignToUser(WS, 'u1', 'r1', MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('assignToUser refuses to modify a user more powerful than the actor (no OWNER lock-out)', async () => {
    const { prisma, svc } = makeSvc();
    // Target's ACTIVE membership in this workspace is OWNER (holds
    // billing.manage / users.manage a MANAGER lacks).
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'OWNER', customRoleId: null } as any);
    // Even a harmless weak role must be refused — assigning it would REPLACE the
    // OWNER's legacy permissions, downgrading + locking them out of settings.
    prisma.customRole.findFirst.mockResolvedValue({ id: 'weak', permissions: ['leads.read'] } as any);
    await expect(svc.assignToUser(WS, 'owner-1', 'weak', MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  // Privilege-floor parity on the UNASSIGN path: clearing a custom role reverts
  // the user to their LEGACY-role perms — itself a grant. A MANAGER must not be
  // able to strip an OWNER-role user's restrictive custom role and hand them back
  // full OWNER power (billing.manage/users.manage the manager lacks).
  it('assignToUser refuses to UNASSIGN a role when the restored legacy perms exceed the actor', async () => {
    const { prisma, svc } = makeSvc();
    // Legacy role OWNER (full perms), currently MASKED by a weak custom role.
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'OWNER', customRoleId: 'weak' } as any);
    // Current perms resolve to the weak role → the MANAGER out-ranks them, so the
    // actor-outranks check passes and only the new within-grant guard can catch it.
    prisma.customRole.findFirst.mockResolvedValue({ id: 'weak', permissions: ['leads.read'] } as any);
    await expect(svc.assignToUser(WS, 'owner-1', null, MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('assignToUser allows UNASSIGN when the restored legacy perms are within the actor grant', async () => {
    const { prisma, svc } = makeSvc();
    // Legacy role REP (a subset of MANAGER's grant) → reverting is safe.
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'REP', customRoleId: 'r1' } as any);
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['leads.read'] } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out = await svc.assignToUser(WS, 'rep-1', null, MANAGER);
    expect(out).toEqual({ userId: 'rep-1', customRoleId: null });
  });

  // Fix 1a (Task 13 review) — the outranks check must evaluate the target at
  // their CURRENT membership role, not their frozen-at-creation MarketingUser
  // role. A user promoted to OWNER after their row was created would still
  // read back as e.g. REP off the stale column, letting a MANAGER "outrank"
  // and modify an OWNER — this is exactly the bug the fix closes.
  it('assignToUser evaluates a promoted target at their CURRENT membership role, not a stale MarketingUser role', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'OWNER', customRoleId: null } as any);
    await expect(svc.assignToUser(WS, 'promoted-1', null, MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    // The read must come from the membership, scoped to THIS workspace and
    // the ACTIVE row — never from marketingUser.
    expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'promoted-1', workspaceId: WS, status: 'ACTIVE' },
      select: { role: true, customRoleId: true },
    });
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('assignToUser 404s when the target has no ACTIVE membership in this workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(null);
    await expect(svc.assignToUser(WS, 'ghost-1', null, MANAGER)).rejects.toBeInstanceOf(NotFoundException);
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

  // Self-action footgun: assigning yourself a weaker custom role strips your own
  // admin access (a custom role REPLACES legacy perms) → self-lockout. Role
  // changes must target OTHERS. Mirrors the user-account self-deactivation guard.
  // This guard fires BEFORE any membership read, so no mock is needed for it.
  it('assignToUser refuses to change the actor’s OWN role', async () => {
    const { prisma, svc } = makeSvc();
    await expect(
      svc.assignToUser(WS, 'me', null, { ...MANAGER, id: 'me' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMembership.findFirst).not.toHaveBeenCalled();
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('assignToUser validates the user + role belong to the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: undefined, customRoleId: undefined } as any);
    prisma.customRole.findFirst.mockResolvedValue({ id: 'r1', permissions: ['leads.read'] } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out = await svc.assignToUser(WS, 'u1', 'r1', OWNER);
    expect(out).toEqual({ userId: 'u1', customRoleId: 'r1' });
  });
});
