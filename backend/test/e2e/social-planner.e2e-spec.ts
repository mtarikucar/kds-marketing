import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';
import * as secretBox from '../../src/common/crypto/secret-box.helper';
import * as networkAdapters from '../../src/modules/marketing/social-planner/network-adapters';

describe('Social Planner (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.META_APP_ID = 'e2e-meta-app-id';
    process.env.META_APP_SECRET = 'e2e-meta-app-secret';
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await closeTestApp(app);
    delete process.env.MARKETING_SECRET_KEY;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  beforeEach(() => jest.clearAllMocks());

  const auth = (role: 'OWNER' | 'MANAGER' | 'REP' = 'OWNER') => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role })}`;
  };

  // ── Auth / Authz ─────────────────────────────────────────────────────────

  it('requires auth for the social planner routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/marketing/social-planner/status');
    expect(res.status).toBe(401);
  });

  it('forbids a REP from using the social planner', async () => {
    const a = auth('REP');
    const res = await request(app.getHttpServer())
      .get('/api/marketing/social-planner/status')
      .set('Authorization', a);
    expect(res.status).toBe(403);
  });

  // ── Status ────────────────────────────────────────────────────────────────

  it('GET /status reports configured networks', async () => {
    const a = auth('OWNER');
    const res = await request(app.getHttpServer())
      .get('/api/marketing/social-planner/status')
      .set('Authorization', a);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      FACEBOOK: true,
      INSTAGRAM: true,
      secretBoxConfigured: true,
    });
    expect(res.body.LINKEDIN).toBe(false);
  });

  // ── Account connect ───────────────────────────────────────────────────────

  it('POST /accounts returns the connected account with token masked', async () => {
    const a = auth('OWNER');
    ctx.prisma.socialAccount.upsert.mockResolvedValue({
      id: 'acc-1',
      workspaceId: 'ws-1',
      network: 'FACEBOOK',
      externalId: 'page-123',
      displayName: 'Test Page',
      accessToken: 'v1:sealed-token-value',
      tokenExpiresAt: null,
      enabled: true,
      createdAt: new Date(),
    } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/social-planner/accounts')
      .set('Authorization', a)
      .send({
        network: 'FACEBOOK',
        externalId: 'page-123',
        displayName: 'Test Page',
        accessToken: 'real-access-token-must-not-leak',
      });

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('real-access-token-must-not-leak');
    expect(JSON.stringify(res.body)).not.toContain('v1:sealed-token-value');
    expect(res.body.accessToken).toMatch(/^••••/);
  });

  it('POST /accounts with invalid network returns 400', async () => {
    const a = auth('OWNER');
    const res = await request(app.getHttpServer())
      .post('/api/marketing/social-planner/accounts')
      .set('Authorization', a)
      .send({ network: 'TIKTOK', externalId: 'x', displayName: 'y', accessToken: 'z' });
    expect(res.status).toBe(400);
  });

  // ── Inert path (MARKETING_SECRET_KEY unset) ──────────────────────────────

  it('POST /accounts returns 400 (clean error) when MARKETING_SECRET_KEY is unset', async () => {
    const saved = process.env.MARKETING_SECRET_KEY;
    delete process.env.MARKETING_SECRET_KEY;
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);

    const a = auth('OWNER');
    const res = await request(app.getHttpServer())
      .post('/api/marketing/social-planner/accounts')
      .set('Authorization', a)
      .send({
        network: 'FACEBOOK',
        externalId: 'page-1',
        displayName: 'Test',
        accessToken: 'raw',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/MARKETING_SECRET_KEY/i);

    jest.restoreAllMocks();
    process.env.MARKETING_SECRET_KEY = saved;
  });

  // ── Posts CRUD ────────────────────────────────────────────────────────────

  it('POST /posts creates a draft post', async () => {
    const a = auth('OWNER');
    const postRow = {
      id: 'post-1',
      workspaceId: 'ws-1',
      content: 'Hello from planner',
      mediaUrls: [],
      status: 'DRAFT',
      scheduledAt: null,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      targets: [],
    };
    ctx.prisma.socialPost.create.mockResolvedValue(postRow as never);
    ctx.prisma.socialPost.findFirst.mockResolvedValue(postRow as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/social-planner/posts')
      .set('Authorization', a)
      .send({ content: 'Hello from planner' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
  });

  it('GET /posts lists all posts for the workspace', async () => {
    const a = auth('OWNER');
    ctx.prisma.socialPost.findMany.mockResolvedValue([] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/social-planner/posts')
      .set('Authorization', a);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /posts/:id returns 404 for unknown post', async () => {
    const a = auth('OWNER');
    ctx.prisma.socialPost.findFirst.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/social-planner/posts/unknown-id')
      .set('Authorization', a);

    expect(res.status).toBe(404);
  });

  it('DELETE /posts/:id deletes a post', async () => {
    const a = auth('OWNER');
    const postRow = {
      id: 'post-del',
      workspaceId: 'ws-1',
      content: 'To be deleted',
      mediaUrls: [],
      status: 'DRAFT',
      scheduledAt: null,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      targets: [],
    };
    ctx.prisma.socialPost.findFirst.mockResolvedValue(postRow as never);
    ctx.prisma.socialPost.delete.mockResolvedValue(postRow as never);

    const res = await request(app.getHttpServer())
      .delete('/api/marketing/social-planner/posts/post-del')
      .set('Authorization', a);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  // ── Schedule ──────────────────────────────────────────────────────────────

  it('POST /posts/:id/schedule sets status SCHEDULED and enqueues a ScheduledJob', async () => {
    const a = auth('OWNER');
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();

    const postRow = {
      id: 'post-sched',
      workspaceId: 'ws-1',
      content: 'Scheduled post',
      mediaUrls: [],
      status: 'DRAFT',
      scheduledAt: null,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      targets: [
        {
          id: 'tgt-1',
          workspaceId: 'ws-1',
          postId: 'post-sched',
          socialAccountId: 'acc-1',
          network: 'FACEBOOK',
          status: 'PENDING',
          externalPostId: null,
          error: null,
        },
      ],
    };

    ctx.prisma.socialPost.findFirst.mockResolvedValue(postRow as never);
    ctx.prisma.socialPostTarget.findMany.mockResolvedValue(postRow.targets as never);
    ctx.prisma.socialPost.update.mockResolvedValue({ ...postRow, status: 'SCHEDULED' } as never);
    ctx.prisma.scheduledJob.create.mockResolvedValue({ id: 'job-sched' } as never);
    ctx.prisma.scheduledJob.findFirst.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/social-planner/posts/post-sched/schedule')
      .set('Authorization', a)
      .send({ scheduledAt });

    expect(res.status).toBe(201);
    expect(ctx.prisma.scheduledJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'social.publish',
          workspaceId: 'ws-1',
          payload: expect.objectContaining({ postId: 'post-sched' }),
          dedupKey: 'social-post-post-sched',
        }),
      }),
    );
  });

  // ── Cross-workspace isolation ─────────────────────────────────────────────

  it('DELETE /accounts/:id returns 404 for an account in another workspace', async () => {
    const a = auth('OWNER');
    ctx.prisma.socialAccount.findFirst.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .delete('/api/marketing/social-planner/accounts/other-ws-account')
      .set('Authorization', a);

    expect(res.status).toBe(404);
  });
});
