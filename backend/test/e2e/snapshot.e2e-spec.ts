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
 * Epic D1 — agency config SNAPSHOTS (e2e).
 *
 *  1. An AGENCY OWNER captures a snapshot from its own workspace (config only)
 *     and lists it back.
 *  2. The same OWNER applies the snapshot to one of its LOCATION children → 200
 *     with a per-type created/skipped summary, and the cloned config is stamped
 *     with the TARGET workspaceId.
 *  3. A STANDALONE workspace OWNER is forbidden on every snapshot route (403) —
 *     the kind gate, not a loosened guard.
 *  4. Applying to a location the agency does NOT own → 404 (assertAgencyOwns),
 *     with no config write.
 */
describe('Agency config snapshots (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  const AGENCY_A = 'agency-a';
  const STANDALONE = 'ws-standalone';
  const LOCATION_A1 = 'loc-a1';
  const SNAP_ID = 'snap-1';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const ownerAuth = (workspaceId: string) => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ id: `owner-${workspaceId}`, workspaceId, role: 'OWNER' }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: `owner-${workspaceId}`, wsp: workspaceId, role: 'OWNER' })}`;
  };

  const agencyKind = (id: string, kind: string) =>
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ id, kind } as never);

  /** Make every config findMany return [] (capture reads). */
  const stubEmptyConfigReads = () => {
    for (const d of [
      'customFieldDef',
      'tag',
      'segment',
      'workflow',
      'agentProfile',
      'sitePage',
      'formDef',
      'bookingCalendar',
      'knowledgeDoc',
      'reviewSource',
    ] as const) {
      (ctx.prisma as any)[d].findMany.mockResolvedValue([] as never);
    }
  };

  // ── 1. Capture + list ──────────────────────────────────────────────────────

  it('AGENCY OWNER captures a snapshot from its own workspace → 201, then lists it', async () => {
    const auth = ownerAuth(AGENCY_A);
    agencyKind(AGENCY_A, 'AGENCY');
    stubEmptyConfigReads();
    // one tag so the payload isn't fully empty
    (ctx.prisma.tag.findMany as jest.Mock).mockResolvedValue([
      { id: 't', workspaceId: AGENCY_A, name: 'VIP', nameLower: 'vip', createdAt: new Date() },
    ] as never);
    (ctx.prisma.snapshot.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: SNAP_ID, createdAt: new Date(), ...args.data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/agency/snapshots')
      .set('Authorization', auth)
      .send({ name: 'Base config' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(SNAP_ID);
    expect(res.body.payload.tags).toHaveLength(1);
    // CONFIG only — no customer-data key, and leads were never read.
    expect(res.body.payload).not.toHaveProperty('leads');
    expect(ctx.prisma.lead.findMany).not.toHaveBeenCalled();
    // Stored as the agency's own row.
    expect((ctx.prisma.snapshot.create as jest.Mock).mock.calls[0][0].data.workspaceId).toBe(
      AGENCY_A,
    );

    // list
    (ctx.prisma.snapshot.findMany as jest.Mock).mockResolvedValue([
      { id: SNAP_ID, name: 'Base config', description: null, createdAt: new Date() },
    ] as never);
    const list = await request(app.getHttpServer())
      .get('/api/marketing/agency/snapshots')
      .set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body[0].id).toBe(SNAP_ID);
  });

  // ── 2. Apply to a child location ───────────────────────────────────────────

  it('AGENCY OWNER applies a snapshot to its LOCATION child → 200, config stamped on target', async () => {
    const auth = ownerAuth(AGENCY_A);
    agencyKind(AGENCY_A, 'AGENCY');
    // assertAgencyOwns resolves the target as a child of AGENCY_A.
    (ctx.prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: LOCATION_A1,
      kind: 'LOCATION',
      parentWorkspaceId: AGENCY_A,
    } as never);
    // The snapshot is owned by AGENCY_A and carries one tag + one custom field.
    (ctx.prisma.snapshot.findFirst as jest.Mock).mockResolvedValue({
      id: SNAP_ID,
      workspaceId: AGENCY_A,
      name: 'Base config',
      payload: {
        customFieldDefs: [{ entity: 'LEAD', key: 'city', label: 'City', type: 'TEXT' }],
        tags: [{ name: 'VIP', nameLower: 'vip' }],
        segments: [],
        workflows: [],
        agentProfiles: [],
        sitePages: [],
        formDefs: [],
        bookingCalendars: [],
        knowledgeDocs: [],
        reviewSources: [],
      },
      createdAt: new Date(),
    } as never);
    // Target is empty → everything created.
    (ctx.prisma.customFieldDef.findFirst as jest.Mock).mockResolvedValue(null);
    (ctx.prisma.tag.findFirst as jest.Mock).mockResolvedValue(null);
    (ctx.prisma.customFieldDef.create as jest.Mock).mockResolvedValue({ id: 'new-cf' } as never);
    (ctx.prisma.tag.create as jest.Mock).mockResolvedValue({ id: 'new-tag' } as never);
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: any) => Promise<any>) => fn(ctx.prisma),
    );

    const res = await request(app.getHttpServer())
      .post(`/api/marketing/agency/snapshots/${SNAP_ID}/apply/${LOCATION_A1}`)
      .set('Authorization', auth)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.targetWorkspaceId).toBe(LOCATION_A1);
    expect(res.body.summary.customFieldDefs).toEqual({ created: 1, skipped: 0 });
    expect(res.body.summary.tags).toEqual({ created: 1, skipped: 0 });
    // Cloned rows stamped with the TARGET workspaceId.
    expect((ctx.prisma.tag.create as jest.Mock).mock.calls[0][0].data.workspaceId).toBe(
      LOCATION_A1,
    );
  });

  // ── 3. Non-agency forbidden ────────────────────────────────────────────────

  it('STANDALONE workspace OWNER is forbidden on snapshot routes → 403', async () => {
    const auth = ownerAuth(STANDALONE);
    agencyKind(STANDALONE, 'STANDALONE');

    const res = await request(app.getHttpServer())
      .get('/api/marketing/agency/snapshots')
      .set('Authorization', auth);

    expect(res.status).toBe(403);
    expect(ctx.prisma.snapshot.findMany).not.toHaveBeenCalled();
  });

  it('STANDALONE workspace OWNER cannot capture → 403, no write', async () => {
    const auth = ownerAuth(STANDALONE);
    agencyKind(STANDALONE, 'STANDALONE');

    const res = await request(app.getHttpServer())
      .post('/api/marketing/agency/snapshots')
      .set('Authorization', auth)
      .send({ name: 'Sneaky' });

    expect(res.status).toBe(403);
    expect(ctx.prisma.snapshot.create).not.toHaveBeenCalled();
  });

  // ── 4. Apply to a non-owned location ───────────────────────────────────────

  it('Applying to a location the agency does NOT own → 404, no config write', async () => {
    const auth = ownerAuth(AGENCY_A);
    agencyKind(AGENCY_A, 'AGENCY');
    // assertAgencyOwns: the parent-scoped lookup finds nothing → 404.
    (ctx.prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .post(`/api/marketing/agency/snapshots/${SNAP_ID}/apply/foreign-loc`)
      .set('Authorization', auth)
      .send({});

    expect(res.status).toBe(404);
    expect(ctx.prisma.customFieldDef.create).not.toHaveBeenCalled();
    expect(ctx.prisma.tag.create).not.toHaveBeenCalled();
  });
});
