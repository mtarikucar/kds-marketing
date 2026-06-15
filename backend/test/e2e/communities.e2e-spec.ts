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
 * Epic C3 — communities end to end (DB seam mocked): create a space, join a
 * lead, post, and comment.
 */
describe('Communities (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ id: 'mu-1' }) as never);
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('creates a community with a slug', async () => {
    ctx.prisma.community.findUnique.mockResolvedValue(null as never);
    (ctx.prisma.community.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'co1', ...data }));

    const res = await request(app.getHttpServer())
      .post('/api/marketing/communities')
      .set('Authorization', auth())
      .send({ name: 'Coffee Club' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: 'coffee-club' });
  });

  it('joins a lead to a community', async () => {
    ctx.prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as never);
    (ctx.prisma.communityMember.upsert as jest.Mock).mockResolvedValue({ id: 'mem1', role: 'MEMBER' });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/communities/co1/join')
      .set('Authorization', auth())
      .send({ leadId: 'lead-1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'mem1' });
  });

  it('creates a post authored by the staff user', async () => {
    ctx.prisma.community.findFirst.mockResolvedValue({ id: 'co1' } as never);
    (ctx.prisma.communityPost.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'p1', ...data }));

    const res = await request(app.getHttpServer())
      .post('/api/marketing/communities/co1/posts')
      .set('Authorization', auth())
      .send({ body: 'Welcome everyone!' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ communityId: 'co1', authorUserId: 'mu-1', body: 'Welcome everyone!' });
  });

  it('adds a comment to a post', async () => {
    ctx.prisma.communityPost.findFirst.mockResolvedValue({ id: 'p1' } as never);
    (ctx.prisma.communityComment.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'cm1', ...data }));

    const res = await request(app.getHttpServer())
      .post('/api/marketing/communities/posts/p1/comments')
      .set('Authorization', auth())
      .send({ body: 'nice' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ postId: 'p1', body: 'nice' });
  });
});
