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
