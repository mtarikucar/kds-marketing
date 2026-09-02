import { randomUUID, createHmac } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * Meta's data-deletion callback against REAL Postgres — the resolve → erase
 * path end to end, through the production HTTP pipeline.
 *
 * Why this can't be a mocked test: the whole claim being made is that a
 * platform-scoped id really resolves to real leads and that
 * ComplianceService's real, transactional erasure really runs against them,
 * in the right tenant and only the right tenant. A mock proves the calls were
 * made; only a real database proves the rows changed.
 *
 * The seed is deliberately CROSS-STAMPED: the SAME Meta PSID exists in TWO
 * workspaces (legal — ContactIdentity is unique on (channelId, value), not on
 * value), plus a third lead in workspace A holding a DIFFERENT id. So the
 * assertions can distinguish "erased both matches" from "erased everything it
 * could see".
 *
 * Opt-in via E2E_REAL_DB=1; the DB is restored to its baseline in afterAll.
 */
const SEED = `del-${randomUUID().slice(0, 8)}`;
const SECRET = 'realdb-meta-app-secret';
const SHARED_PSID = `psid-${randomUUID()}`;
const OTHER_PSID = `psid-${randomUUID()}`;

function sign(userId: string, secret = SECRET): string {
  const body = Buffer.from(
    JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId }),
  ).toString('base64url');
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
}

const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Meta data-deletion callback — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const wsA = randomUUID();
  const wsB = randomUUID();
  const chA = randomUUID();
  const chB = randomUUID();
  const leadA = randomUUID();
  const leadB = randomUUID();
  const leadUntouched = randomUUID();
  /** Everything this spec creates in the (global) request table is stamped after
   *  this instant — teardown removes exactly those rows and nothing else. */
  const testStart = new Date();

  const lead = (id: string, workspaceId: string, name: string) => ({
    id,
    workspaceId,
    businessName: name,
    contactPerson: 'Deniz Deletable',
    phone: '+905551110000',
    email: `${id}@example.com`,
    businessType: 'CAFE',
    source: 'INSTAGRAM',
  });

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    process.env.META_APP_SECRET = SECRET;
    process.env.PUBLIC_BASE_URL = 'https://jeetagrowth.com';
    ({ app, prisma } = await createRealDbTestApp());

    await prisma.workspace.createMany({
      data: [
        { id: wsA, slug: `${SEED}-a`, name: 'Tenant A', productName: 'A', status: 'ACTIVE' },
        { id: wsB, slug: `${SEED}-b`, name: 'Tenant B', productName: 'B', status: 'ACTIVE' },
      ],
    });
    await prisma.channel.createMany({
      data: [
        { id: chA, workspaceId: wsA, type: 'MESSENGER', name: 'A page', externalId: `page-${SEED}-a` },
        { id: chB, workspaceId: wsB, type: 'MESSENGER', name: 'B page', externalId: `page-${SEED}-b` },
      ],
    });
    await prisma.lead.createMany({
      data: [
        lead(leadA, wsA, 'Erase Me A'),
        lead(leadB, wsB, 'Erase Me B'),
        lead(leadUntouched, wsA, 'Keep Me'),
      ],
    });
    await prisma.contactIdentity.createMany({
      data: [
        // The SAME platform id in two different tenants.
        { workspaceId: wsA, channelId: chA, kind: 'PSID', value: SHARED_PSID, leadId: leadA },
        { workspaceId: wsB, channelId: chB, kind: 'PSID', value: SHARED_PSID, leadId: leadB },
        // A neighbour in tenant A that must survive untouched.
        { workspaceId: wsA, channelId: chA, kind: 'PSID', value: OTHER_PSID, leadId: leadUntouched },
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort teardown — never let cleanup throw */
      }
    };
    try {
      await del(() =>
        prisma.platformDeletionRequest.deleteMany({ where: { receivedAt: { gte: testStart } } }),
      );
      await del(() => prisma.dataRequest.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }));
      await del(() => prisma.contactIdentity.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }));
      await del(() => prisma.leadActivity.deleteMany({ where: { leadId: { in: [leadA, leadB, leadUntouched] } } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }));
      await del(() => prisma.channel.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } }));
    } finally {
      delete process.env.META_APP_SECRET;
      delete process.env.PUBLIC_BASE_URL;
      await closeTestApp(app);
    }
  });

  let code: string;

  it('a forged callback changes nothing at all', async () => {
    await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign(SHARED_PSID, 'attacker-secret') })
      .expect(403);

    const still = await prisma.contactIdentity.count({ where: { value: SHARED_PSID } });
    expect(still).toBe(2);
    expect(
      await prisma.platformDeletionRequest.count({ where: { receivedAt: { gte: testStart } } }),
    ).toBe(0);
  });

  it('a verified callback erases the matched leads in BOTH tenants and answers Meta', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign(SHARED_PSID) })
      .expect(200);

    code = res.body.confirmation_code;
    expect(res.body.url).toBe(`https://jeetagrowth.com/data-deletion-status?code=${code}`);

    // Both matched leads are really anonymised (ComplianceService's own path).
    for (const id of [leadA, leadB]) {
      const row = await prisma.lead.findUnique({ where: { id } });
      expect(row.contactPerson).toBe('[Silinmiş]');
      expect(row.email).toBeNull();
      expect(row.phone).toBeNull();
      expect(row.deletedAt).not.toBeNull();
    }
    // …and their identities are gone.
    expect(await prisma.contactIdentity.count({ where: { value: SHARED_PSID } })).toBe(0);

    // The neighbour in tenant A is untouched — the callback erased the MATCHES,
    // not everything the (deliberately cross-workspace) probe could see.
    const kept = await prisma.lead.findUnique({ where: { id: leadUntouched } });
    expect(kept.contactPerson).toBe('Deniz Deletable');
    expect(kept.deletedAt).toBeNull();
    expect(await prisma.contactIdentity.count({ where: { value: OTHER_PSID } })).toBe(1);

    // The audit trail is the normal workspace-scoped DataRequest — one per
    // tenant, each stamped with ITS OWN workspaceId, none with the other's.
    const drA = await prisma.dataRequest.findMany({ where: { workspaceId: wsA, kind: 'ERASURE' } });
    const drB = await prisma.dataRequest.findMany({ where: { workspaceId: wsB, kind: 'ERASURE' } });
    expect(drA).toHaveLength(1);
    expect(drB).toHaveLength(1);
    expect(drA[0].leadId).toBe(leadA);
    expect(drB[0].leadId).toBe(leadB);
    expect(drA[0].status).toBe('COMPLETED');
    expect(drB[0].status).toBe('COMPLETED');

    const rec = await prisma.platformDeletionRequest.findFirst({ where: { confirmationCode: code } });
    expect(rec.status).toBe('COMPLETED');
    expect(rec.matchedLeads).toBe(2);
    expect(rec.dataRequestIds.sort()).toEqual([drA[0].id, drB[0].id].sort());
    // The raw platform id is never stored.
    expect(rec.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.subjectHash).not.toContain(SHARED_PSID);
  });

  it('the status page can read that code back, and 404s an unknown one', async () => {
    const found = await request(app.getHttpServer())
      .get(`/api/public/compliance/data-deletion/status?code=${code}`)
      .expect(200);
    expect(found.body.status).toBe('COMPLETED');
    expect(found.body.completedAt).toBeTruthy();

    await request(app.getHttpServer())
      .get('/api/public/compliance/data-deletion/status?code=not-a-real-code')
      .expect(404);
  });

  it('an id we never stored is RECORDED as unmatched, not answered as a deletion', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign(`asid-${randomUUID()}`) })
      .expect(200);

    const rec = await prisma.platformDeletionRequest.findFirst({
      where: { confirmationCode: res.body.confirmation_code },
    });
    expect(rec.status).toBe('UNMATCHED');
    expect(rec.matchedLeads).toBe(0);

    const status = await request(app.getHttpServer())
      .get(`/api/public/compliance/data-deletion/status?code=${res.body.confirmation_code}`)
      .expect(200);
    expect(status.body.status).toBe('UNMATCHED');
  });

  it('a re-delivered callback returns the SAME confirmation code (Meta retries)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign(SHARED_PSID) })
      .expect(200);
    expect(res.body.confirmation_code).toBe(code);
    // No second erasure was raised against either tenant.
    expect(await prisma.dataRequest.count({ where: { workspaceId: { in: [wsA, wsB] } } })).toBe(2);
  });
});
