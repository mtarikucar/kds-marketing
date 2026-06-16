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
 * Epic A2 — tags end to end through the production pipeline (DB seam mocked):
 * taxonomy CRUD + assigning a tag to a lead (auto-create by name) + unassigning.
 */
describe('Tags (e2e)', () => {
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
      mockMarketingUser() as never,
    );
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('creates a tag (case-insensitive name stored normalized)', async () => {
    ctx.prisma.tag.findUnique.mockResolvedValue(null as never);
    (ctx.prisma.tag.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 't1', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/tags')
      .set('Authorization', auth())
      .send({ name: 'VIP' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'VIP', nameLower: 'vip' });
  });

  it('lists tags with member counts', async () => {
    ctx.prisma.tag.findMany.mockResolvedValue([
      { id: 't1', workspaceId: 'ws-1', name: 'vip', color: null, createdAt: new Date(), _count: { leadTags: 4 } },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/tags')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: 't1', name: 'vip', count: 4 });
  });

  it('assigns a tag to a lead by name, auto-creating it', async () => {
    ctx.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as never);
    ctx.prisma.tag.findUnique.mockResolvedValue(null as never);
    (ctx.prisma.tag.create as jest.Mock).mockResolvedValue({ id: 't1', name: 'vip' } as never);
    ctx.prisma.leadTag.findMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ tag: { id: 't1', name: 'vip', color: null } }] as never);
    (ctx.prisma.leadTag.createMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/leads/lead-1/tags')
      .set('Authorization', auth())
      .send({ tags: ['vip'] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual([{ id: 't1', name: 'vip', color: null }]);
    expect(ctx.prisma.leadTag.createMany).toHaveBeenCalled();
  });

  it('unassigns a tag from a lead', async () => {
    ctx.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as never);
    (ctx.prisma.leadTag.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(app.getHttpServer())
      .delete('/api/marketing/leads/lead-1/tags/t1')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 1 });
  });
});
