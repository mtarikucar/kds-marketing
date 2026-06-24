import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * Epic F — granular @RequirePermission enforcement rolled out across the
 * marketing mutation endpoints. The contract these tests pin:
 *
 *  1. NO REGRESSION — a user on a LEGACY role (OWNER/MANAGER/REP, no custom
 *     role) keeps exactly the access they had before, because the permission
 *     keys chosen for each endpoint were picked so the legacy-role→permission
 *     fallback grants them to the same roles the old @MarketingRoles gate did.
 *  2. CUSTOM ROLES ENFORCE — once a user is assigned a custom role, its
 *     permission set OVERRIDES the legacy mapping: missing the required
 *     permission ⇒ 403; holding it ⇒ the guard passes (handler runs).
 *
 * The guard short-circuits BEFORE the handler, so the "denied" cases need no
 * service mocks (a 403 proves the guard fired). For "allowed" cases we assert
 * the response is NOT 403 — the request cleared the PermissionsGuard — without
 * coupling to each service's full happy path (covered by their own e2e specs).
 */
describe('Granular permission enforcement (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  /** Authenticate as a legacy role (no custom role) — the fallback path. */
  const legacy = (role: string) => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role, customRoleId: null }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role })}`;
  };

  /**
   * Authenticate as a user whose CUSTOM role carries exactly `permissions`.
   * The user's legacy `role` is deliberately OWNER to prove the custom role —
   * not the legacy role — is what the guard consults.
   */
  const custom = (permissions: string[]) => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role: 'OWNER', customRoleId: 'cr-1' }) as never,
    );
    // resolvePermissions now reads the custom role workspace-scoped via findFirst.
    ctx.prisma.customRole.findFirst.mockResolvedValue({
      id: 'cr-1',
      permissions,
    } as never);
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'OWNER' })}`;
  };

  const send = (method: 'post' | 'patch' | 'delete', path: string, auth: string, body?: object) => {
    const r = request(app.getHttpServer())[method](path).set('Authorization', auth);
    return body ? r.send(body) : r;
  };

  // ── REP-tier write endpoints (leads.write): the legacy NO-role-gate
  //    endpoints stay open to REP; a custom role without leads.write is blocked.
  describe("leads.write — POST /marketing/leads (REP-allowed today)", () => {
    const path = '/api/marketing/leads';
    const body = { firstName: 'A', lastName: 'B', email: 'a@b.com' };

    it('legacy REP still passes the permission guard (no regression)', async () => {
      const res = await send('post', path, legacy('REP'), body);
      expect(res.status).not.toBe(403);
    });

    it('legacy MANAGER still passes', async () => {
      const res = await send('post', path, legacy('MANAGER'), body);
      expect(res.status).not.toBe(403);
    });

    it('custom role WITHOUT leads.write is forbidden (403)', async () => {
      const res = await send('post', path, custom(['reports.read']), body);
      expect(res.status).toBe(403);
    });

    it('custom role WITH leads.write passes the guard', async () => {
      const res = await send('post', path, custom(['leads.write']), body);
      expect(res.status).not.toBe(403);
    });
  });

  // ── Manager-tier lead admin (leads.manage): the legacy @MarketingRoles
  //    ('MANAGER') gate — REP must NOT reach it; MANAGER must.
  describe("leads.manage — DELETE /marketing/leads/:id (MANAGER-only today)", () => {
    const path = '/api/marketing/leads/lead-1';

    it('legacy MANAGER passes (held leads.manage via fallback)', async () => {
      const res = await send('delete', path, legacy('MANAGER'));
      expect(res.status).not.toBe(403);
    });

    it('legacy REP is forbidden — exactly as before (REP lacks leads.manage)', async () => {
      const res = await send('delete', path, legacy('REP'));
      expect(res.status).toBe(403);
    });

    it('custom role without leads.manage is forbidden (403)', async () => {
      const res = await send('delete', path, custom(['leads.write']));
      expect(res.status).toBe(403);
    });

    it('custom role with leads.manage passes', async () => {
      const res = await send('delete', path, custom(['leads.manage']));
      expect(res.status).not.toBe(403);
    });
  });

  // ── Manager-tier config (settings.manage): team-member management is
  //    @MarketingRoles('MANAGER') (no feature gate), so every 403 here is
  //    unambiguously the PermissionsGuard. REP blocked, MANAGER allowed.
  describe("settings.manage — POST /marketing/users (MANAGER-only today)", () => {
    const path = '/api/marketing/users';
    const body = { email: 'rep@x.com', firstName: 'R', lastName: 'P', role: 'REP', password: 'Sup3rSecret!' };

    it('legacy MANAGER passes (held settings.manage via fallback)', async () => {
      const res = await send('post', path, legacy('MANAGER'), body);
      expect(res.status).not.toBe(403);
    });

    it('legacy REP is forbidden — exactly as before', async () => {
      const res = await send('post', path, legacy('REP'), body);
      expect(res.status).toBe(403);
    });

    it('custom role without settings.manage is forbidden (403)', async () => {
      const res = await send('post', path, custom(['leads.write', 'campaigns.send']), body);
      expect(res.status).toBe(403);
    });

    it('custom role with settings.manage passes the guard', async () => {
      const res = await send('post', path, custom(['settings.manage']), body);
      expect(res.status).not.toBe(403);
    });
  });

  // ── Campaign-send tier (campaigns.send): social-planner publishing carries
  //    @MarketingRoles('OWNER','MANAGER'). NOTE the MarketingRolesGuard uses
  //    "highest co-listed role wins", so that gate is effectively OWNER-ONLY for
  //    legacy users — exactly mirroring the roles-controller precedent of
  //    pairing an OWNER-listed gate with a granular permission. The permission
  //    layer (campaigns.send) is what lets a *custom* role be granted this
  //    without the legacy OWNER role.
  describe("campaigns.send — POST /marketing/social-planner/accounts", () => {
    const path = '/api/marketing/social-planner/accounts';
    const body = { platform: 'facebook', externalId: 'fb-1', displayName: 'Page' };

    it('legacy OWNER passes (OWNER holds campaigns.send)', async () => {
      const res = await send('post', path, legacy('OWNER'), body);
      expect(res.status).not.toBe(403);
    });

    it('legacy REP is forbidden — exactly as before', async () => {
      const res = await send('post', path, legacy('REP'), body);
      expect(res.status).toBe(403);
    });

    it('custom role with only campaigns.READ (not send) is forbidden', async () => {
      const res = await send('post', path, custom(['campaigns.read']), body);
      expect(res.status).toBe(403);
    });

    it('custom role with campaigns.send passes the guard', async () => {
      const res = await send('post', path, custom(['campaigns.send']), body);
      expect(res.status).not.toBe(403);
    });
  });

  // ── Owner-only org admin (users.manage): agency location creation is
  //    @MarketingRoles('OWNER'). MANAGER must NOT reach it; OWNER must.
  describe("users.manage — POST /marketing/agency/locations (OWNER-only today)", () => {
    const path = '/api/marketing/agency/locations';
    const body = { name: 'Sub Account', ownerEmail: 'o@x.com', ownerPassword: 'Sup3rSecret!' };

    it('legacy OWNER passes (only OWNER holds users.manage)', async () => {
      const res = await send('post', path, legacy('OWNER'), body);
      expect(res.status).not.toBe(403);
    });

    it('legacy MANAGER is forbidden — exactly as before (MANAGER lacks users.manage)', async () => {
      const res = await send('post', path, legacy('MANAGER'), body);
      expect(res.status).toBe(403);
    });

    it('custom role without users.manage is forbidden (403)', async () => {
      const res = await send('post', path, custom(['settings.manage']), body);
      expect(res.status).toBe(403);
    });

    it('custom role with users.manage passes the guard', async () => {
      const res = await send('post', path, custom(['users.manage']), body);
      expect(res.status).not.toBe(403);
    });
  });

  // ── Owner-only billing (billing.manage): checkout is @MarketingRoles('OWNER').
  describe("billing.manage — POST /marketing/billing/checkout (OWNER-only today)", () => {
    const path = '/api/marketing/billing/checkout';
    const body = { plan: 'PRO' };

    it('legacy OWNER passes (only OWNER holds billing.manage)', async () => {
      const res = await send('post', path, legacy('OWNER'), body);
      expect(res.status).not.toBe(403);
    });

    it('legacy MANAGER is forbidden — exactly as before', async () => {
      const res = await send('post', path, legacy('MANAGER'), body);
      expect(res.status).toBe(403);
    });

    it('custom role with billing.manage passes the guard', async () => {
      const res = await send('post', path, custom(['billing.manage']), body);
      expect(res.status).not.toBe(403);
    });
  });
});
