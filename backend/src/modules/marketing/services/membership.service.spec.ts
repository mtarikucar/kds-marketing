import { MembershipService } from './membership.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

function makeSvc() {
  const prisma = mockPrismaClient();
  // These tests exercise the pre-existing authz-resolution reads only (never
  // invite()), so the jwt/config/entitlements mocks just need to satisfy the
  // constructor. entitlements defaults to unlimited so a stray call from
  // invite() (not exercised by this file) wouldn't seat-limit anything.
  const jwt = { sign: jest.fn() };
  const config = { get: jest.fn() };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ maxUsers: -1 }) };
  return {
    prisma,
    svc: new MembershipService(prisma as any, jwt as any, config as any, entitlements as any),
  };
}

describe('MembershipService', () => {
  it('getActiveMembership returns the ACTIVE membership for (user, workspace)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue({
      id: 'm1', workspaceId: 'ws-1', role: 'MANAGER', customRoleId: null,
    });
    const m = await svc.getActiveMembership('u1', 'ws-1');
    expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', workspaceId: 'ws-1', status: 'ACTIVE' },
      select: { id: true, workspaceId: true, role: true, customRoleId: true },
    });
    expect(m).toMatchObject({ role: 'MANAGER' });
  });

  it('getActiveMembership returns null when suspended/absent', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await svc.getActiveMembership('u1', 'ws-x')).toBeNull();
  });

  it('resolveDefaultWorkspaceId prefers the home pointer when a membership exists for it', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValueOnce({ workspaceId: 'home' });
    const ws = await svc.resolveDefaultWorkspaceId('u1', 'home');
    expect(ws).toBe('home');
  });

  it('resolveDefaultWorkspaceId falls back to the most-recent ACTIVE membership when home has none', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // no membership for the home pointer
      .mockResolvedValueOnce({ workspaceId: 'recent' }); // most-recent ACTIVE
    const ws = await svc.resolveDefaultWorkspaceId('u1', 'home');
    expect(ws).toBe('recent');
  });

  it('listActiveMemberships joins workspace names', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findMany as jest.Mock).mockResolvedValue([
      { workspaceId: 'ws-1', role: 'OWNER' }, { workspaceId: 'ws-2', role: 'REP' },
    ]);
    (prisma.workspace.findMany as jest.Mock).mockResolvedValue([
      { id: 'ws-1', name: 'Brand A' }, { id: 'ws-2', name: 'Brand B' },
    ]);
    const out = await svc.listActiveMemberships('u1');
    expect(out).toEqual([
      { workspaceId: 'ws-1', workspaceName: 'Brand A', role: 'OWNER' },
      { workspaceId: 'ws-2', workspaceName: 'Brand B', role: 'REP' },
    ]);
  });
});
