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
 * Epic A5 — CSV import end to end (DB seam mocked): upload returns a suggested
 * mapping, commit flips the job to RUNNING and enqueues the batch worker, and
 * status reads the job back.
 */
describe('Lead CSV import (e2e)', () => {
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

  it('uploads a CSV and returns a suggested mapping', async () => {
    (ctx.prisma.importJob.create as jest.Mock).mockResolvedValue({ id: 'imp-1' });
    (ctx.prisma.importJobRow.createMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/imports')
      .set('Authorization', auth())
      .send({ filename: 'leads.csv', content: 'Company,E-Mail\nAcme,a@x.com' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      jobId: 'imp-1',
      headers: ['Company', 'E-Mail'],
      suggestedMapping: { Company: 'businessName', 'E-Mail': 'email' },
      total: 1,
    });
  });

  it('commits a mapping and enqueues the batch worker', async () => {
    ctx.prisma.importJob.findFirst.mockResolvedValue({ id: 'imp-1', workspaceId: 'ws-1', status: 'MAPPING' } as never);
    (ctx.prisma.importJob.update as jest.Mock).mockResolvedValue({});
    ctx.prisma.scheduledJob.findFirst.mockResolvedValue(null as never);
    (ctx.prisma.scheduledJob.create as jest.Mock).mockResolvedValue({ id: 'sj-1' });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/imports/imp-1/commit')
      .set('Authorization', auth())
      .send({ mapping: { Company: 'businessName', 'E-Mail': 'email' }, dedupePolicy: 'CREATE' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ jobId: 'imp-1', status: 'RUNNING' });
    expect(ctx.prisma.scheduledJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'import.batch' }) }),
    );
  });

  it('reads import job status', async () => {
    ctx.prisma.importJob.findFirst.mockResolvedValue({
      id: 'imp-1', workspaceId: 'ws-1', status: 'DONE', total: 1, created: 1, skipped: 0, failed: 0,
    } as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/imports/imp-1')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'imp-1', status: 'DONE', created: 1 });
  });
});
