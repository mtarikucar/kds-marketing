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
 * Epic B4 — Slack integration end to end (DB seam mocked): create (webhook URL
 * never echoed back), send a test message, and REP is forbidden.
 */
describe('Slack integration (e2e)', () => {
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

  it('creates an integration without echoing the webhook URL', async () => {
    const auth = ownerAuth();
    (ctx.prisma.slackIntegration.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'i1', channel: null, events: [], status: 'ACTIVE', lastNotifiedAt: null, createdAt: new Date(), ...data }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/marketing/integrations/slack')
      .set('Authorization', auth)
      .send({ webhookUrl: 'https://hooks.slack.com/services/xxx' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('i1');
    expect(res.body.webhookUrl).toBeUndefined();
  });

  it('sends a test message', async () => {
    const auth = ownerAuth();
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true });
    ctx.prisma.slackIntegration.findFirst.mockResolvedValue({ id: 'i1', webhookUrl: 'https://hooks.slack.com/services/xxx' } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/integrations/slack/i1/test')
      .set('Authorization', auth);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('forbids a REP', async () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'REP' }) as never);
    const res = await request(app.getHttpServer())
      .post('/api/marketing/integrations/slack')
      .set('Authorization', `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'REP' })}`)
      .send({ webhookUrl: 'https://hooks.slack.com/services/xxx' });
    expect(res.status).toBe(403);
  });
});
