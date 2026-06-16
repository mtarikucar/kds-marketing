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
 * Epic B2 — outbound webhook management end to end (DB seam mocked): create
 * (returns the signing secret once), reject an unsupported event, list without
 * the secret, queue a test delivery, and delete.
 */
describe('Outbound webhooks (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role: 'OWNER' }) as never,
    );
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'OWNER' })}`;

  it('creates an endpoint and returns the signing secret once', async () => {
    (ctx.prisma.webhookEndpoint.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'ep-1', status: 'ACTIVE', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/webhooks')
      .set('Authorization', auth())
      .send({ url: 'https://hook.example/x', events: ['marketing.lead.created.v1'] });

    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    expect(res.body.events).toEqual(['marketing.lead.created.v1']);
  });

  it('rejects an unsupported event type', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/webhooks')
      .set('Authorization', auth())
      .send({ url: 'https://hook.example/x', events: ['totally.bogus.v1'] });

    expect(res.status).toBe(400);
    expect(ctx.prisma.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it('lists endpoints without exposing the secret', async () => {
    ctx.prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', url: 'https://hook.example/x', events: [], status: 'ACTIVE', failureCount: 0, lastDeliveryAt: null, createdAt: new Date() },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/webhooks')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe('ep-1');
    expect(res.body[0].secret).toBeUndefined();
  });

  it('queues a test delivery', async () => {
    ctx.prisma.webhookEndpoint.findFirst.mockResolvedValue({ id: 'ep-1', workspaceId: 'ws-1' } as never);
    (ctx.prisma.webhookDelivery.create as jest.Mock).mockResolvedValue({ id: 'd1' });
    ctx.prisma.scheduledJob.findFirst.mockResolvedValue(null as never);
    (ctx.prisma.scheduledJob.create as jest.Mock).mockResolvedValue({ id: 'sj-1' });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/webhooks/ep-1/test')
      .set('Authorization', auth());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'QUEUED' });
    expect(ctx.prisma.scheduledJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'webhook.deliver' }) }),
    );
  });

  it('deletes an endpoint', async () => {
    ctx.prisma.webhookEndpoint.findFirst.mockResolvedValue({ id: 'ep-1' } as never);
    (ctx.prisma.webhookEndpoint.delete as jest.Mock).mockResolvedValue({});

    const res = await request(app.getHttpServer())
      .delete('/api/marketing/webhooks/ep-1')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'ep-1' });
  });
});
