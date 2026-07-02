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
    ctx.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as never); // workspace-scoped lead guard
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
    // Progress recompute derives total from courseLessons() → course.findUnique
    // (modules→lessons). Two lessons (l1 done + l2) → 1/2 = 50%. Without this the
    // deep-mock returns undefined → ordered=[] → total=0 → progressPct 0.
    (ctx.prisma.course.findUnique as jest.Mock).mockResolvedValue({
      dripMode: null,
      modules: [{ lessons: [
        { id: 'l1', position: 0, isPreview: false, gating: null, dripDays: null },
        { id: 'l2', position: 1, isPreview: false, gating: null, dripDays: null },
      ] }],
    });
    // Epic 10a drip/gating reads the completed-lessons set before allowing a complete;
    // without this the deep-mock returns undefined → undefined.map → 500.
    (ctx.prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (ctx.prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    // The advisory-lock recompute derives `done` from a FRESH DB count
    // (`tx.lessonProgress.count` scoped to the live lesson ids), not from the
    // findMany set — the shared test-app deep-mock defaults every `.count` to 0
    // (test-app.ts), so without this override `done`=0 → progressPct 0 instead
    // of 50. After upserting l1, the live count of completed lessons is 1 → 1/2.
    (ctx.prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    // Progress recomputes over the LIVE lesson set, read via course.findUnique
    // (nested modules→lessons), not lesson.count. Ungated 2-lesson course →
    // completing l1 of {l1,l2} = 50%.
    (ctx.prisma.course.findUnique as jest.Mock).mockResolvedValue({
      dripMode: null,
      modules: [
        {
          lessons: [
            { id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null },
            { id: 'l2', position: 1, isPreview: false, gating: 'FREE', dripDays: null },
          ],
        },
      ],
    });
    (ctx.prisma.enrollment.update as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve({ id: 'e1', ...data }));
    // Epic C2 fix 157f495 wrapped the persist+recompute in a $transaction; the
    // deep-mock returns undefined for an un-stubbed $transaction → undefined.status
    // → 500. Run the callback against the same mock so the inner update flows through.
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(ctx.prisma));

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
