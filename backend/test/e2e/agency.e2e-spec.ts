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
 * Epic D1 — agency / sub-account hierarchy (e2e).
 *
 *  1. An AGENCY OWNER creates a LOCATION sub-account (201, child carries
 *     kind=LOCATION + parentWorkspaceId=agency) and lists it back.
 *  2. A STANDALONE workspace OWNER is forbidden on every agency route (403) —
 *     the kind gate, not a loosened guard.
 *  3. Agency-A cannot read Agency-B's location (404, no cross-tenant leak):
 *     the parent-scoped lookup returns null for the wrong parent.
 *  4. A REP in an agency is forbidden (OWNER-only routes, 403).
 */
describe('Agency / sub-account hierarchy (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  const AGENCY_A = 'agency-a';
  const AGENCY_B = 'agency-b';
  const STANDALONE = 'ws-standalone';
  const LOCATION_A1 = 'loc-a1';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  // ── Workspace fixtures ─────────────────────────────────────────────────────

  const workspaceKindRow = (id: string, kind: string) => ({ id, kind });

  const locationRow = (over: Record<string, unknown> = {}) => ({
    id: LOCATION_A1,
    slug: 'loc-a1',
    name: 'Location A1',
    status: 'ACTIVE',
    kind: 'LOCATION',
    parentWorkspaceId: AGENCY_A,
    productName: 'Sub Product',
    productUrl: null,
    defaultLanguage: 'en',
    defaultCurrency: 'USD',
    timezone: 'UTC',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  /**
   * Auth as an OWNER of a workspace whose `kind` is provided. The controller's
   * assertAgencyKind and the service's assertIsAgency both read the workspace by
   * id, so we route those reads by id to the right kind.
   */
  const ownerAuth = (workspaceId: string, kind: string) => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ id: `owner-${workspaceId}`, workspaceId, role: 'OWNER' }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: `owner-${workspaceId}`, wsp: workspaceId, role: 'OWNER' })}`;
  };

  // ── 1. Agency owner creates + lists locations ──────────────────────────────

  it('AGENCY OWNER creates a LOCATION sub-account → 201 (kind=LOCATION, parent set)', async () => {
    const auth = ownerAuth(AGENCY_A, 'AGENCY');

    // Workspace reads: controller kind-gate + service assertIsAgency + tx
    // slug-probe. Route by id+select so the agency reads return AGENCY and the
    // slug probe (selects only id) returns null (slug free).
    (ctx.prisma.workspace.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === AGENCY_A && args?.select?.kind) {
        return Promise.resolve(workspaceKindRow(AGENCY_A, 'AGENCY'));
      }
      if (args?.where?.id === AGENCY_A) {
        return Promise.resolve({ id: AGENCY_A, kind: 'AGENCY', status: 'ACTIVE' });
      }
      return Promise.resolve(null); // slug-collision probe by slug → free
    });
    (ctx.prisma.marketingUser.findUnique as jest.Mock).mockImplementation((args: any) => {
      // The MarketingGuard re-reads the user by id (sub); the createLocation
      // email-collision probe reads by email → free.
      if (args?.where?.id) {
        return Promise.resolve(
          mockMarketingUser({ id: `owner-${AGENCY_A}`, workspaceId: AGENCY_A, role: 'OWNER' }),
        );
      }
      return Promise.resolve(null);
    });

    ctx.prisma.workspace.create.mockResolvedValue(locationRow() as never);
    ctx.prisma.marketingUser.create.mockResolvedValue({ id: 'child-owner' } as never);
    ctx.prisma.marketingDistributionConfig.create.mockResolvedValue({ id: 'd1' } as never);
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: any) => Promise<any>) => fn(ctx.prisma),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/agency/locations')
      .set('Authorization', auth)
      .send({
        name: 'Location A1',
        productName: 'Sub Product',
        ownerEmail: 'owner@a1.com',
        ownerPassword: 'password123',
        ownerFirstName: 'Owen',
        ownerLastName: 'Owner',
      });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('LOCATION');
    expect(res.body.parentWorkspaceId).toBe(AGENCY_A);
  });

  it('AGENCY OWNER lists its own locations → 200', async () => {
    const auth = ownerAuth(AGENCY_A, 'AGENCY');
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: AGENCY_A,
      kind: 'AGENCY',
      status: 'ACTIVE',
    } as never);
    ctx.prisma.workspace.findMany.mockResolvedValue([locationRow()] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/agency/locations')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(LOCATION_A1);
  });

  // ── 2. Non-agency workspace is forbidden ───────────────────────────────────

  it('STANDALONE workspace OWNER is forbidden on agency routes → 403', async () => {
    const auth = ownerAuth(STANDALONE, 'STANDALONE');
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: STANDALONE,
      kind: 'STANDALONE',
    } as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/agency/locations')
      .set('Authorization', auth);

    expect(res.status).toBe(403);
    // The kind gate fires before any cross-workspace read.
    expect(ctx.prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it('STANDALONE workspace OWNER cannot create a location → 403', async () => {
    const auth = ownerAuth(STANDALONE, 'STANDALONE');
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: STANDALONE,
      kind: 'STANDALONE',
    } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/agency/locations')
      .set('Authorization', auth)
      .send({
        name: 'Sneaky',
        productName: 'X',
        ownerEmail: 'sneak@x.com',
        ownerPassword: 'password123',
        ownerFirstName: 'S',
        ownerLastName: 'N',
      });

    expect(res.status).toBe(403);
    expect(ctx.prisma.workspace.create).not.toHaveBeenCalled();
  });

  // ── 3. Cross-agency isolation ──────────────────────────────────────────────

  it('Agency-A cannot read Agency-B’s location → 404 (no cross-tenant leak)', async () => {
    const auth = ownerAuth(AGENCY_B, 'AGENCY');
    // Agency-B is a real agency (kind gate passes)…
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: AGENCY_B,
      kind: 'AGENCY',
      status: 'ACTIVE',
    } as never);
    // …but the parent-scoped lookup for loc-a1 (whose parent is AGENCY_A) finds
    // nothing under parentWorkspaceId=AGENCY_B → 404.
    ctx.prisma.workspace.findFirst.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .get(`/api/marketing/agency/locations/${LOCATION_A1}`)
      .set('Authorization', auth);

    expect(res.status).toBe(404);
    const where = (ctx.prisma.workspace.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.parentWorkspaceId).toBe(AGENCY_B);
  });

  it('Agency-B cannot suspend Agency-A’s location → 404, no write', async () => {
    const auth = ownerAuth(AGENCY_B, 'AGENCY');
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: AGENCY_B,
      kind: 'AGENCY',
      status: 'ACTIVE',
    } as never);
    ctx.prisma.workspace.findFirst.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .patch(`/api/marketing/agency/locations/${LOCATION_A1}/suspend`)
      .set('Authorization', auth)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(404);
    expect(ctx.prisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  // ── 4. RBAC inside an agency ───────────────────────────────────────────────

  it('REP in an AGENCY is forbidden on OWNER-only agency routes → 403', async () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ id: 'rep-1', workspaceId: AGENCY_A, role: 'REP' }) as never,
    );
    const auth = `Bearer ${signMarketingToken({ sub: 'rep-1', wsp: AGENCY_A, role: 'REP' })}`;

    const res = await request(app.getHttpServer())
      .get('/api/marketing/agency/locations')
      .set('Authorization', auth);

    expect(res.status).toBe(403);
  });
});
