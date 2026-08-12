import { BadRequestException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import {
  MCP_ATTRIBUTION_PRINCIPAL_ROLE,
  MCP_NON_REP_PRINCIPAL,
  McpPrincipalService,
  visibilityPrincipal,
} from './mcp-principal.service';

/**
 * Faz 5 D1 — who a WRITE is attributed to.
 *
 * The read-only placeholder (`MCP_NON_REP_PRINCIPAL`) is a synthetic id that
 * owns no rows; it is safe only because it never leaves a read `where`. Every
 * D1 write lands in a column that is a real FK (`LeadActivity.createdById`,
 * `MarketingTask.assignedToId`, both non-null with `onDelete: Restrict`), so
 * the write lane must resolve a REAL, workspace-local, active user or refuse.
 */
function prismaMock() {
  return {
    // The sentinel (API-key attribution) lane still resolves the workspace's
    // SYSTEM user row — 3 prod sentinels have no membership at all, so that
    // lookup must NOT move to memberships.
    marketingUser: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // Belonging, role and status come from the membership: the user row's
    // copies are frozen at creation.
    workspaceMembership: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

/** A membership row shaped as the service selects it. */
function membership(role: string, status = 'ACTIVE', user: Record<string, unknown> = {}) {
  return {
    role,
    status,
    user: {
      id: 'u9',
      workspaceId: 'ws-a',
      email: 'u9@example.com',
      firstName: 'Real',
      lastName: 'User',
      role,
      status,
      customRoleId: null,
      ...user,
    },
  };
}

function svc() {
  const prisma = prismaMock();
  return { svc: new McpPrincipalService(prisma as never), prisma };
}

const SENTINEL = {
  id: 'sys-1',
  workspaceId: 'ws-a',
  email: 'research+ws-a@system.internal',
  firstName: 'AI',
  lastName: 'Research',
  role: 'SYSTEM',
  status: 'ACTIVE',
  customRoleId: null,
};

describe('visibilityPrincipal', () => {
  it('falls back to the declared non-REP placeholder with no user in context', () => {
    expect(visibilityPrincipal({ workspaceId: 'ws-a', grantedScopes: [] })).toEqual({
      userId: MCP_NON_REP_PRINCIPAL.userId,
      role: MCP_NON_REP_PRINCIPAL.role,
    });
  });

  it('uses the real caller and their freshly-resolved role on an OAuth session', () => {
    expect(
      visibilityPrincipal({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' }),
    ).toEqual({ userId: 'u9', role: 'REP' });
  });

  it('never pairs a real user id with the placeholder id, nor the placeholder id with a real role', () => {
    // A user id with no resolved role keeps the "not REP" placeholder role —
    // pairing the SYNTHETIC id with a real role would return zero rows.
    expect(visibilityPrincipal({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u9' })).toEqual({
      userId: 'u9',
      role: MCP_NON_REP_PRINCIPAL.role,
    });
    expect(visibilityPrincipal({ workspaceId: 'ws-a', grantedScopes: [], userRole: 'REP' })).toEqual({
      userId: MCP_NON_REP_PRINCIPAL.userId,
      role: MCP_NON_REP_PRINCIPAL.role,
    });
  });
});

describe('McpPrincipalService.resolve', () => {
  it('resolves the REAL user on an OAuth session, pinned to this workspace and ACTIVE', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(
      membership('REP', 'ACTIVE', { email: 'rep@x.com', firstName: 'Ali', lastName: 'Veli' }),
    );

    const actor = await s.resolve({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' });

    expect(actor.id).toBe('u9');
    expect(actor.role).toBe('REP');
    // Membership, not the frozen MarketingUser mirror.
    expect(prisma.workspaceMembership.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'u9',
      workspaceId: 'ws-a',
      status: 'ACTIVE',
    });
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
  });

  it("refuses when the OAuth user is not an active member of THIS workspace (cannot borrow another tenant's user)", async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(null);
    await expect(
      s.resolve({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u-foreign' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prefers the invoker-resolved role over the stored row (a demotion bites immediately)', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(membership('MANAGER'));
    const actor = await s.resolve({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' });
    expect(actor.role).toBe('REP');
  });

  it('falls back to the workspace automation principal on an API-key session', async () => {
    const { svc: s, prisma } = svc();
    prisma.marketingUser.findFirst.mockResolvedValue(SENTINEL);

    const actor = await s.resolve({ workspaceId: 'ws-a', grantedScopes: [] });

    expect(actor.id).toBe('sys-1');
    expect(actor.role).toBe(MCP_ATTRIBUTION_PRINCIPAL_ROLE);
    // Scoped to the caller's workspace — never a global lookup.
    expect(prisma.marketingUser.findFirst.mock.calls[0][0].where).toEqual({
      workspaceId: 'ws-a',
      role: MCP_ATTRIBUTION_PRINCIPAL_ROLE,
    });
  });

  it('never resolves the automation principal to a REP role (row-level narrowing would hide everything)', async () => {
    const { svc: s, prisma } = svc();
    prisma.marketingUser.findFirst.mockResolvedValue(SENTINEL);
    const actor = await s.resolve({ workspaceId: 'ws-a', grantedScopes: [] });
    expect(actor.role).not.toBe('REP');
  });

  it('refuses rather than inventing an id when the workspace has no automation principal', async () => {
    const { svc: s, prisma } = svc();
    prisma.marketingUser.findFirst.mockResolvedValue(null);
    await expect(s.resolve({ workspaceId: 'ws-a', grantedScopes: [] })).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('McpPrincipalService.assertActiveMember', () => {
  it('accepts an ACTIVE member, resolved from the membership not the frozen mirror', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(membership('REP', 'ACTIVE', { id: 'u2' }));
    await expect(s.assertActiveMember('ws-a', 'u2')).resolves.toMatchObject({ id: 'u2', role: 'REP' });
    expect(prisma.workspaceMembership.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'u2',
      workspaceId: 'ws-a',
    });
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
  });

  it('rejects someone with no membership in this workspace', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(null);
    await expect(s.assertActiveMember('ws-a', 'u-foreign')).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * The half the frozen mirror could never see: revoking a membership leaves
   * `MarketingUser.status` ACTIVE and `workspaceId` unchanged, so the old read
   * kept handing work to someone who can no longer log in.
   */
  it('rejects a member whose membership is no longer ACTIVE', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(membership('REP', 'SUSPENDED'));
    await expect(s.assertActiveMember('ws-a', 'u9')).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * The other half: a teammate who joined THIS workspace by membership but was
   * created in another one. Prod already contains such a row, and the old read
   * refused them outright — you could not assign them anything at all.
   */
  it('accepts a member whose user row was created in a different workspace', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(
      membership('MANAGER', 'ACTIVE', { id: 'u-elsewhere', workspaceId: 'ws-OTHER' }),
    );
    await expect(s.assertActiveMember('ws-a', 'u-elsewhere')).resolves.toMatchObject({
      id: 'u-elsewhere',
      role: 'MANAGER',
    });
  });

  it('rejects the automation principal as an assignment target — it can never log in to act on the work', async () => {
    const { svc: s, prisma } = svc();
    prisma.workspaceMembership.findFirst.mockResolvedValue(
      membership(MCP_ATTRIBUTION_PRINCIPAL_ROLE, 'ACTIVE', { id: 'sys-1' }),
    );
    await expect(s.assertActiveMember('ws-a', 'sys-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
