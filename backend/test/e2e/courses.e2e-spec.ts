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
 * Epic C1 — courses end to end (DB seam mocked): create (slug derived), add a
 * module, add a lesson (scoped via the module), the publish-needs-lessons guard,
 * and reading a nested course.
 */
describe('Courses (e2e)', () => {
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

  it('creates a course, deriving a slug', async () => {
    ctx.prisma.course.findUnique.mockResolvedValue(null as never);
    (ctx.prisma.course.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'c1', status: 'DRAFT', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/courses')
      .set('Authorization', auth())
      .send({ title: 'Intro to Coffee' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: 'intro-to-coffee', status: 'DRAFT' });
  });

  it('adds a module to a course', async () => {
    ctx.prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as never);
    (ctx.prisma.courseModule.count as jest.Mock).mockResolvedValue(0);
    (ctx.prisma.courseModule.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'm1', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/courses/c1/modules')
      .set('Authorization', auth())
      .send({ title: 'Module 1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'm1', courseId: 'c1', position: 0 });
  });

  it('adds a lesson scoped through the module', async () => {
    ctx.prisma.courseModule.findFirst.mockResolvedValue({ id: 'm1', courseId: 'c1' } as never);
    (ctx.prisma.lesson.count as jest.Mock).mockResolvedValue(0);
    (ctx.prisma.lesson.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'l1', ...data }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/courses/modules/m1/lessons')
      .set('Authorization', auth())
      .send({ title: 'Lesson 1', type: 'VIDEO' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ moduleId: 'm1', type: 'VIDEO', position: 0 });
  });

  it('refuses to publish a course with no lessons (400)', async () => {
    ctx.prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as never);
    (ctx.prisma.lesson.count as jest.Mock).mockResolvedValue(0);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/courses/c1/publish')
      .set('Authorization', auth());

    expect(res.status).toBe(400);
  });

  it('reads a nested course', async () => {
    ctx.prisma.course.findFirst.mockResolvedValue({
      id: 'c1', title: 'Intro', modules: [{ id: 'm1', lessons: [{ id: 'l1' }] }],
    } as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/courses/c1')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.modules[0].lessons[0].id).toBe('l1');
  });
});
