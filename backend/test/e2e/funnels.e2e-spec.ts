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
 * Epic E — A/B experiments + surveys end to end (DB seam mocked): create + start
 * an experiment, pick a public variant (impression) + convert, and create +
 * publicly submit a survey.
 */
describe('Funnels — experiments + surveys (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser() as never);
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('creates and starts an experiment', async () => {
    (ctx.prisma.experiment.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'e1', ...data }));
    const create = await request(app.getHttpServer())
      .post('/api/marketing/experiments')
      .set('Authorization', auth())
      .send({ name: 'Hero test', variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }] });
    expect(create.status).toBe(201);

    ctx.prisma.experiment.findFirst.mockResolvedValue({ id: 'e1', variants: [{ key: 'a' }, { key: 'b' }] } as never);
    (ctx.prisma.experiment.update as jest.Mock).mockResolvedValue({ id: 'e1', status: 'RUNNING' });
    const start = await request(app.getHttpServer())
      .post('/api/marketing/experiments/e1/start')
      .set('Authorization', auth());
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('RUNNING');
  });

  it('selects a public variant (records an impression) and converts', async () => {
    ctx.prisma.experiment.findUnique.mockResolvedValue({
      id: 'e1', workspaceId: 'ws-1', status: 'RUNNING', variants: [{ key: 'a', weight: 1 }],
    } as never);
    (ctx.prisma.experimentEvent.create as jest.Mock).mockResolvedValue({});

    const variant = await request(app.getHttpServer()).get('/api/public/exp/e1/variant');
    expect(variant.status).toBe(200);
    expect(variant.body.variantKey).toBe('a');

    const convert = await request(app.getHttpServer())
      .post('/api/public/exp/e1/convert')
      .send({ variantKey: 'a' });
    expect(convert.status).toBe(201);
    expect(convert.body).toEqual({ ok: true });
  });

  it('creates a survey and accepts a public submission', async () => {
    (ctx.prisma.survey.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 's1', ...data }));
    const create = await request(app.getHttpServer())
      .post('/api/marketing/surveys')
      .set('Authorization', auth())
      .send({ name: 'NPS' });
    expect(create.status).toBe(201);

    ctx.prisma.survey.findUnique.mockResolvedValue({ id: 's1', workspaceId: 'ws-1', status: 'PUBLISHED', redirectUrl: null } as never);
    (ctx.prisma.surveyResponse.create as jest.Mock).mockResolvedValue({});
    const submit = await request(app.getHttpServer())
      .post('/api/public/survey/s1/submit')
      .send({ answers: { score: 9 } });
    expect(submit.status).toBe(201);
  });
});
