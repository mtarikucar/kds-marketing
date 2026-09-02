import { createHmac } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp } from '../utils/test-app';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

/**
 * The PUBLIC Meta data-deletion callback + its public status endpoint, through
 * the real request pipeline (raw urlencoded body → global ValidationPipe →
 * throttler → controller). These are the two URLs the owner pastes into the
 * Meta App Dashboard, so their shape is a contract, not an implementation
 * detail:
 *
 *   POST /api/public/compliance/meta/data-deletion   → { url, confirmation_code }
 *   GET  /api/public/compliance/data-deletion/status?code=…
 *
 * The security of the callback is entirely the signed_request HMAC: it is
 * unauthenticated by design (Meta cannot present a credential), so a request
 * that does not verify must be REFUSED, never processed.
 */
const SECRET = 'e2e-meta-app-secret';

function sign(userId: string, secret = SECRET): string {
  const body = Buffer.from(
    JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId }),
  ).toString('base64url');
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
}

describe('Meta data-deletion callback (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: DeepMockProxy<PrismaClient>;

  beforeAll(async () => {
    process.env.META_APP_SECRET = SECRET;
    process.env.PUBLIC_BASE_URL = 'https://jeetagrowth.com';
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    delete process.env.META_APP_SECRET;
    delete process.env.PUBLIC_BASE_URL;
    await closeTestApp(app);
  });

  beforeEach(() => {
    (prisma.platformDeletionRequest.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.platformDeletionRequest.create as jest.Mock).mockImplementation(async (args: any) => ({
      id: 'pdr-1',
      ...args.data,
    }));
    (prisma.platformDeletionRequest.update as jest.Mock).mockResolvedValue({});
    (prisma.contactIdentity.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('answers a form-encoded, correctly-signed callback with Meta’s required shape', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign('an-app-scoped-id') })
      .expect(200);

    expect(Object.keys(res.body).sort()).toEqual(['confirmation_code', 'url']);
    expect(res.body.confirmation_code).toMatch(/^[a-z0-9]+$/i);
    expect(res.body.url).toBe(
      `https://jeetagrowth.com/data-deletion-status?code=${res.body.confirmation_code}`,
    );
  });

  it('accepts a JSON-bodied callback too (same contract)', async () => {
    await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .send({ signed_request: sign('another-id') })
      .expect(200);
  });

  it('REFUSES a forged signed_request (403) and writes nothing', async () => {
    (prisma.platformDeletionRequest.create as jest.Mock).mockClear();
    await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign('victim-id', 'attacker-secret') })
      .expect(403);
    expect(prisma.platformDeletionRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a request with no signed_request at all (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({})
      .expect(400);
  });

  it('never echoes the signed_request back in any response', async () => {
    const sr = sign('echo-check');
    const ok = await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sr })
      .expect(200);
    const bad = await request(app.getHttpServer())
      .post('/api/public/compliance/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign('echo-check', 'wrong') })
      .expect(403);
    expect(JSON.stringify(ok.body)).not.toContain(sr.slice(0, 24));
    expect(JSON.stringify(bad.body)).not.toContain('echo-check');
  });

  it('serves a known confirmation code, and 404s an unknown one rather than a blank success', async () => {
    (prisma.platformDeletionRequest.findFirst as jest.Mock).mockResolvedValueOnce({
      confirmationCode: 'abc123',
      status: 'UNMATCHED',
      receivedAt: new Date('2026-09-02T00:00:00.000Z'),
      completedAt: new Date('2026-09-02T00:00:01.000Z'),
      subjectHash: 'a'.repeat(64),
      dataRequestIds: ['dr-1'],
    });
    const found = await request(app.getHttpServer())
      .get('/api/public/compliance/data-deletion/status?code=abc123')
      .expect(200);
    expect(found.body.status).toBe('UNMATCHED');
    // The public status must not leak the subject digest or internal audit ids.
    expect(Object.keys(found.body).sort()).toEqual([
      'completedAt',
      'confirmationCode',
      'receivedAt',
      'status',
    ]);

    (prisma.platformDeletionRequest.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await request(app.getHttpServer())
      .get('/api/public/compliance/data-deletion/status?code=nope')
      .expect(404);
  });
});
