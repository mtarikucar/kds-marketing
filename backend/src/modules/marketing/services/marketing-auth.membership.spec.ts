import { JwtService } from '@nestjs/jwt';
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
    svc = new MarketingAuthService({} as never, jwtService, config as never, smsOtp as never);
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
