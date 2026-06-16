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
 * Epic C2 — enrollment + progress end to end (DB seam mocked): enroll a lead,
 * complete a lesson and see progress recompute, read progress.
 */
describe('Enrollment (e2e)', () => {
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

  it('enrolls a lead into a course', async () => {
    ctx.prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as never);
    (ctx.prisma.enrollment.upsert as jest.Mock).mockResolvedValue({ id: 'e1', courseId: 'c1', leadId: 'lead-1', progressPct: 0 });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/enrollments')
      .set('Authorization', auth())
      .send({ courseId: 'c1', leadId: 'lead-1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'e1', courseId: 'c1' });
  });

  it('completes a lesson and recomputes progress', async () => {
    ctx.prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1' } as never);
    ctx.prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as never);
    (ctx.prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (ctx.prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (ctx.prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (ctx.prisma.enrollment.update as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'e1', ...data }));

    const res = await request(app.getHttpServer())
      .post('/api/marketing/enrollments/e1/complete-lesson')
      .set('Authorization', auth())
      .send({ lessonId: 'l1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ progressPct: 50, status: 'ACTIVE' });
  });

  it('reads enrollment progress', async () => {
    ctx.prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', progressPct: 50 } as never);
    ctx.prisma.lessonProgress.findMany.mockResolvedValue([{ lessonId: 'l1', completed: true }] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/enrollments/e1')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.progress).toHaveLength(1);
  });
});
