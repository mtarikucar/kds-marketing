import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Epic B3 — public REST API v1 end to end (DB seam mocked): an API key
 * authenticates the request, read/write scope is enforced, and the workspace is
 * taken from the key (never the body).
 */
describe('Public API v1 (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const KEY = 'Bearer mk_live_testkey';
  const activeKey = (scopes: string[]) =>
    ctx.prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1', workspaceId: 'ws-1', status: 'ACTIVE', scopes,
    } as never);

  it('lists leads with a read-scoped key', async () => {
    activeKey(['read', 'write']);
    (ctx.prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1', businessName: 'Acme' }]);
    (ctx.prisma.lead.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app.getHttpServer())
      .get('/api/v1/leads')
      .set('Authorization', KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // scoped to the key's workspace
    const findArg = (ctx.prisma.lead.findMany as jest.Mock).mock.calls[0][0];
    expect(findArg.where.workspaceId).toBe('ws-1');
  });

  it('creates a lead with a write-scoped key', async () => {
    activeKey(['read', 'write']);
    ctx.prisma.lead.findFirst.mockResolvedValue(null as never);
    ctx.prisma.customFieldDef.findMany.mockResolvedValue([] as never);
    (ctx.prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'l1', businessName: 'Acme' });

    const res = await request(app.getHttpServer())
      .post('/api/v1/leads')
      .set('Authorization', KEY)
      .send({ businessName: 'Acme', contactPerson: 'Ada', businessType: 'CAFE', source: 'WEBSITE' });

    expect(res.status).toBe(201);
    const createArg = (ctx.prisma.lead.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.workspaceId).toBe('ws-1');
  });

  it('rejects a request with no API key (401)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/leads');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown key (401)', async () => {
    ctx.prisma.apiKey.findUnique.mockResolvedValue(null as never);
    const res = await request(app.getHttpServer())
      .get('/api/v1/leads')
      .set('Authorization', 'Bearer mk_live_nope');
    expect(res.status).toBe(401);
  });

  it('forbids a write with a read-only key (403)', async () => {
    activeKey(['read']);
    const res = await request(app.getHttpServer())
      .post('/api/v1/leads')
      .set('Authorization', KEY)
      .send({ businessName: 'Acme', contactPerson: 'Ada', businessType: 'CAFE', source: 'WEBSITE' });
    expect(res.status).toBe(403);
  });
});
