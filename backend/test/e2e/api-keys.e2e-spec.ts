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
 * Epic B1 — API key management end to end (DB seam mocked): create returns the
 * raw key once, list shows only the prefix, revoke flips status, and a REP is
 * forbidden from minting keys.
 */
describe('API keys (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const ownerAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'OWNER' }) as never);
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'OWNER' })}`;
  };

  it('creates a key and returns the raw value once', async () => {
    const auth = ownerAuth();
    (ctx.prisma.apiKey.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'k1', status: 'ACTIVE', createdAt: new Date(), ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/api-keys')
      .set('Authorization', auth)
      .send({ name: 'Zapier' });

    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^mk_live_/);
    expect(res.body.prefix).toBe(res.body.key.slice(0, 16));
    // the stored hash is never returned
    expect(res.body.keyHash).toBeUndefined();
  });

  it('lists keys without exposing the hash', async () => {
    const auth = ownerAuth();
    ctx.prisma.apiKey.findMany.mockResolvedValue([
      { id: 'k1', name: 'Zapier', prefix: 'mk_live_abcd', scopes: ['read', 'write'], status: 'ACTIVE', lastUsedAt: null, createdAt: new Date(), revokedAt: null },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/api-keys')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: 'k1', prefix: 'mk_live_abcd' });
    expect(res.body[0].keyHash).toBeUndefined();
  });

  it('revokes a key', async () => {
    const auth = ownerAuth();
    ctx.prisma.apiKey.findFirst.mockResolvedValue({ id: 'k1' } as never);
    (ctx.prisma.apiKey.update as jest.Mock).mockResolvedValue({});

    const res = await request(app.getHttpServer())
      .delete('/api/marketing/api-keys/k1')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'k1', status: 'REVOKED' });
  });

  it('forbids a REP from minting keys', async () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'REP' }) as never);
    const res = await request(app.getHttpServer())
      .post('/api/marketing/api-keys')
      .set('Authorization', `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'REP' })}`)
      .send({ name: 'Sneaky' });

    expect(res.status).toBe(403);
  });
});
