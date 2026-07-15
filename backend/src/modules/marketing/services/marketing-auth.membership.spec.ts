import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { MarketingAuthService } from './marketing-auth.service';

/**
 * Phase 1 Task 4 — `generateTokens`/`issueSession` must stamp the ACTIVE
 * MEMBERSHIP's workspace+role into the JWT (and the returned `user` echo),
 * not the MarketingUser row's home `workspaceId`/`role`. This is what lets a
 * user who is a member of several workspaces carry a session scoped to
 * whichever one they're currently "in", independent of their home row.
 *
 * A real JwtService is used (not a jest.fn() stub) so `.decode()` actually
 * parses the token `generateTokens`/`issueSession` produced, rather than a
 * canned string — the assertions need the real `wsp`/`role` claims.
 */
describe('MarketingAuthService — tokens carry the active membership', () => {
  let svc: MarketingAuthService;
  let jwtService: JwtService;

  beforeEach(() => {
    jwtService = new JwtService();
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        return undefined;
      }),
    };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    // These tests call generateTokens/issueSession directly, never through
    // login/verify2fa, so the membership mock's behavior is irrelevant here —
    // it only needs to exist to satisfy the constructor.
    const membership = { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() };
    svc = new MarketingAuthService(
      {} as never,
      jwtService,
      config as never,
      smsOtp as never,
      membership as never,
    );
  });

  it('generateTokens stamps wsp+role from the active membership, not the user row', async () => {
    // user.role/home = OWNER of wsp-home; active membership = REP of wsp-2
    const tokens = (svc as any).generateTokens(
      { id: 'u1', workspaceId: 'wsp-home', email: 'a@b.co', firstName: 'A', lastName: 'B', phone: null, avatar: null, role: 'OWNER', tokenVersion: 0 },
      { workspaceId: 'wsp-2', role: 'REP' },
    );
    const decoded: any = jwtService.decode(tokens.accessToken);
    expect(decoded.wsp).toBe('wsp-2');
    expect(decoded.role).toBe('REP');
    expect(tokens.user.workspaceId).toBe('wsp-2');
    expect(tokens.user.role).toBe('REP');
  });

  it('issueSession forwards the active membership the same way (SSO/agency-impersonation seam)', () => {
    const tokens = svc.issueSession(
      { id: 'u2', workspaceId: 'wsp-home', email: 'c@d.co', firstName: 'C', lastName: 'D', phone: null, avatar: null, role: 'OWNER', tokenVersion: 0 },
      { workspaceId: 'wsp-3', role: 'MANAGER' },
    );
    const decoded: any = jwtService.decode(tokens.accessToken);
    expect(decoded.wsp).toBe('wsp-3');
    expect(decoded.role).toBe('MANAGER');
    expect(tokens.user.workspaceId).toBe('wsp-3');
    expect(tokens.user.role).toBe('MANAGER');
  });

  it('the refresh token carries the same active wsp+role as the access token', () => {
    const tokens = (svc as any).generateTokens(
      { id: 'u3', workspaceId: 'wsp-home', email: 'e@f.co', firstName: 'E', lastName: 'F', phone: null, avatar: null, role: 'OWNER', tokenVersion: 0 },
      { workspaceId: 'wsp-4', role: 'REP' },
    );
    const decoded: any = jwtService.decode(tokens.refreshToken);
    expect(decoded.wsp).toBe('wsp-4');
    expect(decoded.role).toBe('REP');
    expect(decoded.tokenType).toBe('refresh');
  });
});

/**
 * Phase 1 Task 5 — login/verify2fa no longer trust the MarketingUser row's
 * home `workspaceId`/`role` at face value; they hand off to
 * MembershipService to resolve which ACTIVE membership is "default" (home
 * pointer if still ACTIVE, else most-recently-created ACTIVE membership) and
 * mint the session for THAT workspace+role. A user with zero ACTIVE
 * memberships (e.g. removed from every workspace they belonged to) must be
 * refused outright rather than handed a session for a membership that no
 * longer exists.
 */
describe('MarketingAuthService — login lands on the default membership', () => {
  let svc: MarketingAuthService;
  let jwtService: JwtService;
  let prisma: any;
  let membership: { resolveDefaultWorkspaceId: jest.Mock; getActiveMembership: jest.Mock };

  const PASSWORD = 'correct-horse-battery-staple';
  let PASSWORD_HASH: string;
  beforeAll(async () => {
    PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4); // low cost — tests only, not security-relevant
  });

  function baseUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      workspaceId: 'home',
      email: 'a@b.co',
      password: PASSWORD_HASH,
      firstName: 'A',
      lastName: 'B',
      phone: null,
      avatar: null,
      role: 'OWNER',
      status: 'ACTIVE',
      failedLogins: 0,
      lockedUntil: null,
      tokenVersion: 0,
      twoFactorEnabled: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    jwtService = new JwtService();
    prisma = {
      marketingUser: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        return undefined;
      }),
    };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    membership = { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() };
    svc = new MarketingAuthService(
      prisma as never,
      jwtService,
      config as never,
      smsOtp as never,
      membership as never,
    );
  });

  it('login lands on the default membership resolved by MembershipService', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
    membership.resolveDefaultWorkspaceId.mockResolvedValue('home');
    membership.getActiveMembership.mockResolvedValue({
      workspaceId: 'home',
      role: 'OWNER',
      customRoleId: null,
    });

    const out: any = await svc.login({ email: 'a@b.co', password: PASSWORD } as any);

    expect(membership.resolveDefaultWorkspaceId).toHaveBeenCalledWith('u1', 'home');
    expect(jwtService.decode(out.accessToken)).toMatchObject({ wsp: 'home', role: 'OWNER' });
  });

  it('login 401s a user with no ACTIVE membership', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
    membership.resolveDefaultWorkspaceId.mockResolvedValue(null);

    await expect(
      svc.login({ email: 'a@b.co', password: PASSWORD } as any),
    ).rejects.toThrow('No active workspace');
  });
});

/**
 * Phase 1 Task 6 — refreshToken must NOT reset the session to the user's
 * home workspace. It has to preserve whichever workspace the refresh token
 * itself was scoped to (its `wsp` claim) and re-verify, at refresh time, that
 * the membership backing that workspace is still ACTIVE — a membership
 * revoked mid-session must kill the refresh loop rather than silently
 * surviving on the stale token until the 8h access token expires.
 */
describe('MarketingAuthService — refreshToken preserves the active workspace', () => {
  let svc: MarketingAuthService;
  let jwtService: JwtService;
  let prisma: any;
  let membership: { resolveDefaultWorkspaceId: jest.Mock; getActiveMembership: jest.Mock };

  function baseUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      workspaceId: 'home',
      email: 'a@b.co',
      firstName: 'A',
      lastName: 'B',
      phone: null,
      avatar: null,
      role: 'OWNER',
      status: 'ACTIVE',
      tokenVersion: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    jwtService = new JwtService();
    prisma = {
      marketingUser: { findUnique: jest.fn() },
      workspace: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        return undefined;
      }),
    };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    membership = { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() };
    svc = new MarketingAuthService(
      prisma as never,
      jwtService,
      config as never,
      smsOtp as never,
      membership as never,
    );
  });

  /** Signs a refresh token exactly like generateTokens does, so refreshToken's
   *  own jwtService.verifyAsync(refreshSecret) accepts it. */
  function sign(payload: Record<string, unknown>) {
    return jwtService.sign(payload, { secret: 'refresh-secret', algorithm: 'HS256' });
  }

  it('refresh keeps the token active workspace (does not reset to home)', async () => {
    // Stale token claim says OWNER; the re-verified membership says REP.
    // The minted access token must carry the membership's role, not the
    // stale claim — this is what catches a regression that reads
    // payload.role instead of calling MembershipService.getActiveMembership.
    const refresh = sign({ sub: 'u1', wsp: 'wsp-2', role: 'OWNER', ver: 0, type: 'marketing', tokenType: 'refresh' });
    prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
    membership.getActiveMembership.mockResolvedValue({ workspaceId: 'wsp-2', role: 'REP', customRoleId: null });

    const out: any = await svc.refreshToken(refresh);

    expect(membership.getActiveMembership).toHaveBeenCalledWith('u1', 'wsp-2');
    expect(jwtService.decode(out.accessToken)).toMatchObject({ wsp: 'wsp-2', role: 'REP' });
  });

  it('refresh 401s when the token workspace membership was revoked', async () => {
    const refresh = sign({ sub: 'u1', wsp: 'wsp-2', ver: 0, type: 'marketing', tokenType: 'refresh' });
    prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
    membership.getActiveMembership.mockResolvedValue(null);

    await expect(svc.refreshToken(refresh)).rejects.toThrow('Session revoked');
  });
});

/**
 * Phase 1 Task 7 — switchWorkspace re-mints the session for a DIFFERENT
 * workspace the caller already belongs to. It must verify an ACTIVE
 * WorkspaceMembership for (userId, targetWorkspaceId) BEFORE minting — this
 * is the property refresh() later trusts blindly (it re-verifies the `wsp`
 * claim's membership, but never re-derives it), so a switch that signed a
 * `wsp` claim for a workspace the caller isn't an ACTIVE member of would let
 * that claim ride the refresh loop forever. A non-member target must 403
 * with no distinction from "workspace doesn't exist" (no enumeration).
 */
describe('MarketingAuthService — switchWorkspace', () => {
  let svc: MarketingAuthService;
  let jwtService: JwtService;
  let prisma: any;
  let membership: { resolveDefaultWorkspaceId: jest.Mock; getActiveMembership: jest.Mock };

  function baseUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      workspaceId: 'home',
      email: 'a@b.co',
      firstName: 'A',
      lastName: 'B',
      phone: null,
      avatar: null,
      role: 'OWNER',
      status: 'ACTIVE',
      tokenVersion: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    jwtService = new JwtService();
    prisma = {
      marketingUser: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      workspace: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        return undefined;
      }),
    };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    membership = { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() };
    svc = new MarketingAuthService(
      prisma as never,
      jwtService,
      config as never,
      smsOtp as never,
      membership as never,
    );
  });

  it('switchWorkspace re-mints for a workspace the user is an ACTIVE member of', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
    membership.getActiveMembership.mockResolvedValue({ workspaceId: 'wsp-2', role: 'MANAGER', customRoleId: null });

    const out: any = await svc.switchWorkspace('u1', 'wsp-2');

    expect(membership.getActiveMembership).toHaveBeenCalledWith('u1', 'wsp-2');
    expect(jwtService.decode(out.accessToken)).toMatchObject({ wsp: 'wsp-2', role: 'MANAGER' });
    expect(prisma.marketingUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' }, data: { workspaceId: 'wsp-2' } }),
    );
  });

  it('switchWorkspace 403s a non-member target (no enumeration)', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(baseUser());
    membership.getActiveMembership.mockResolvedValue(null);

    await expect(svc.switchWorkspace('u1', 'foreign')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });
});

/**
 * Phase 1 Task 8 — GET /auth/profile must surface the caller's full ACTIVE
 * membership set (so the FE can offer a workspace switcher), while keeping
 * `workspace` at the top level exactly as before — `useWorkspaceProfile`
 * reads `data.workspace` directly and must keep working unmodified.
 */
describe('MarketingAuthService — profile()', () => {
  let svc: MarketingAuthService;
  let prisma: any;
  let membership: {
    resolveDefaultWorkspaceId: jest.Mock;
    getActiveMembership: jest.Mock;
    listActiveMemberships: jest.Mock;
  };

  beforeEach(() => {
    const jwtService = new JwtService();
    prisma = {
      marketingUser: { findUnique: jest.fn() },
      workspace: { findUnique: jest.fn() },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MARKETING_JWT_SECRET') return 'access-secret';
        if (key === 'MARKETING_JWT_REFRESH_SECRET') return 'refresh-secret';
        return undefined;
      }),
    };
    const smsOtp = { issue: jest.fn(), verify: jest.fn() };
    membership = {
      resolveDefaultWorkspaceId: jest.fn(),
      getActiveMembership: jest.fn(),
      listActiveMemberships: jest.fn(),
    };
    svc = new MarketingAuthService(
      prisma as never,
      jwtService,
      config as never,
      smsOtp as never,
      membership as never,
    );
  });

  it('returns memberships alongside a top-level workspace (backward-compatible with useWorkspaceProfile)', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue({
      id: 'u1',
      workspaceId: 'ws-1',
      email: 'a@b.co',
      firstName: 'A',
      lastName: 'B',
      phone: null,
      avatar: null,
      role: 'OWNER',
      status: 'ACTIVE',
      lastLogin: null,
      createdAt: new Date(),
    });
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      name: 'Acme',
      kind: 'STANDALONE',
      productName: 'Acme CRM',
      productUrl: null,
      defaultLanguage: 'en',
      defaultCurrency: 'TRY',
      settings: {},
    });
    membership.listActiveMemberships.mockResolvedValue([
      { workspaceId: 'ws-1', workspaceName: 'Acme', role: 'OWNER' },
      { workspaceId: 'ws-2', workspaceName: 'Beta', role: 'REP' },
    ]);

    const res: any = await svc.profile('u1', 'ws-1');

    // workspace still resolves off the ACTIVE (passed-in) workspaceId, not
    // the user row's home pointer, and keeps its existing shape.
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ws-1' } }),
    );
    expect(res.workspace).toMatchObject({ id: 'ws-1', name: 'Acme', kind: 'STANDALONE' });
    expect(res.memberships).toEqual([
      { workspaceId: 'ws-1', workspaceName: 'Acme', role: 'OWNER' },
      { workspaceId: 'ws-2', workspaceName: 'Beta', role: 'REP' },
    ]);
    expect(membership.listActiveMemberships).toHaveBeenCalledWith('u1');
    // User fields stay flat at the top level — nothing pre-existing moved.
    expect(res.id).toBe('u1');
    expect(res.email).toBe('a@b.co');
  });

  it('throws BadRequestException when the user row is gone', async () => {
    prisma.marketingUser.findUnique.mockResolvedValue(null);
    prisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1' });
    membership.listActiveMemberships.mockResolvedValue([]);

    await expect(svc.profile('ghost', 'ws-1')).rejects.toThrow('User not found');
  });
});
