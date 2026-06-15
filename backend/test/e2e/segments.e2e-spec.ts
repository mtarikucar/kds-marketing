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
 * Epic A3 — segments end to end (DB seam mocked): create with a predicate tree,
 * preview a count, list members, and reject an invalid definition with a 400.
 */
describe('Segments (e2e)', () => {
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
    // No custom fields defined → cf: keys would be rejected; native-only here.
    ctx.prisma.customFieldDef.findMany.mockResolvedValue([] as never);
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;
  const def = { op: 'and', children: [{ field: 'status', cmp: 'in', value: ['NEW', 'CONTACTED'] }] };

  it('creates a segment from a valid predicate tree', async () => {
    (ctx.prisma.segment.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 's1', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/segments')
      .set('Authorization', auth())
      .send({ name: 'Active leads', definition: def });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 's1', name: 'Active leads', kind: 'DYNAMIC' });
  });

  it('previews a count + sample', async () => {
    (ctx.prisma.lead.count as jest.Mock).mockResolvedValue(12);
    (ctx.prisma.lead.findMany as jest.Mock).mockResolvedValue([
      { id: 'l1', businessName: 'Bistro', status: 'NEW' },
    ]);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/segments/preview')
      .set('Authorization', auth())
      .send({ definition: def });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(12);
    expect(res.body.sample).toHaveLength(1);
  });

  it('lists members of a saved segment', async () => {
    ctx.prisma.segment.findFirst.mockResolvedValue({ id: 's1', definition: def } as never);
    (ctx.prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1' }]);
    (ctx.prisma.lead.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/segments/s1/members')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(res.body.items).toHaveLength(1);
  });

  it('rejects an invalid definition (unknown field) with 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/segments')
      .set('Authorization', auth())
      .send({ name: 'Bad', definition: { field: 'bogus', cmp: 'eq', value: 1 } });

    expect(res.status).toBe(400);
    expect(ctx.prisma.segment.create).not.toHaveBeenCalled();
  });
});
