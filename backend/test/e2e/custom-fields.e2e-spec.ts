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
 * Epic A1 — custom fields end to end, through the production pipeline (guard →
 * ValidationPipe → controller → service), with the DB seam mocked. Asserts the
 * def-CRUD contract and that lead create routes `customFields` through
 * validation: a valid value is echoed back; an out-of-options SELECT is a 400.
 */
describe('Custom fields (e2e)', () => {
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

  const auth = () =>
    `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('creates a custom field def, deriving a snake_case key', async () => {
    ctx.prisma.customFieldDef.findUnique.mockResolvedValue(null as never);
    (ctx.prisma.customFieldDef.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'd1', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/custom-fields')
      .set('Authorization', auth())
      .send({ label: 'Annual Budget', type: 'NUMBER' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'annual_budget', type: 'NUMBER' });
  });

  it('lists custom field defs', async () => {
    ctx.prisma.customFieldDef.findMany.mockResolvedValue([
      { id: 'd1', key: 'budget', label: 'Budget', type: 'NUMBER' },
      { id: 'd2', key: 'tier', label: 'Tier', type: 'SELECT' },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/custom-fields')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].key).toBe('budget');
  });

  it('accepts a lead with a valid custom field value and echoes the coerced map', async () => {
    ctx.prisma.customFieldDef.findMany.mockResolvedValue([
      { key: 'budget', type: 'NUMBER', options: null, required: false },
    ] as never);
    ctx.prisma.lead.findFirst.mockResolvedValue(null as never);
    (ctx.prisma.lead.create as jest.Mock).mockResolvedValue({
      id: 'lead-1',
      businessName: 'Bistro',
      customFields: { budget: 1500 },
    } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/leads')
      .set('Authorization', auth())
      .send({
        businessName: 'Bistro',
        contactPerson: 'Ada',
        businessType: 'CAFE',
        source: 'WEBSITE',
        customFields: { budget: '1500' },
      });

    expect(res.status).toBe(201);
    expect(res.body.customFields).toEqual({ budget: 1500 });
    const createArg = (ctx.prisma.lead.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.customFields).toEqual({ budget: 1500 });
  });

  it('rejects a lead whose SELECT custom field is not in the allowed options (400)', async () => {
    ctx.prisma.customFieldDef.findMany.mockResolvedValue([
      {
        key: 'tier',
        type: 'SELECT',
        options: [{ value: 'gold', label: 'Gold' }],
        required: false,
      },
    ] as never);
    ctx.prisma.lead.findFirst.mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/leads')
      .set('Authorization', auth())
      .send({
        businessName: 'Bistro',
        contactPerson: 'Ada',
        businessType: 'CAFE',
        source: 'WEBSITE',
        customFields: { tier: 'platinum' },
      });

    expect(res.status).toBe(400);
    expect(ctx.prisma.lead.create).not.toHaveBeenCalled();
  });
});
