import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new CoursesService(prisma as any) };
}

describe('CoursesService', () => {
  it('creates a course deriving a slug and rejects a duplicate slug', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findUnique.mockResolvedValue(null as any);
    (prisma.course.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'c1', ...a.data }));
    const created: any = await svc.create(WS, { title: 'Intro to Coffee' });
    expect(created.slug).toBe('intro-to-coffee');

    prisma.course.findUnique.mockResolvedValue({ id: 'c1' } as any);
    await expect(svc.create(WS, { title: 'Intro to Coffee' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to publish a course with no lessons', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    (prisma.lesson.count as jest.Mock).mockResolvedValue(0);
    await expect(svc.publish(WS, 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('publishes a course that has lessons', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    (prisma.lesson.count as jest.Mock).mockResolvedValue(3);
    (prisma.course.update as jest.Mock).mockResolvedValue({ id: 'c1', status: 'PUBLISHED' });
    const out: any = await svc.publish(WS, 'c1');
    expect(out.status).toBe('PUBLISHED');
  });

  it('appends a module at the next position', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    (prisma.courseModule.count as jest.Mock).mockResolvedValue(2);
    (prisma.courseModule.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'm1', ...a.data }));
    const out: any = await svc.addModule(WS, 'c1', 'Module 3');
    expect(out.position).toBe(2);
  });

  it('appends a lesson scoped through its module', async () => {
    const { prisma, svc } = makeSvc();
    prisma.courseModule.findFirst.mockResolvedValue({ id: 'm1', courseId: 'c1' } as any);
    (prisma.lesson.count as jest.Mock).mockResolvedValue(1);
    (prisma.lesson.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'l1', ...a.data }));
    const out: any = await svc.addLesson(WS, 'm1', { title: 'Lesson 2', type: 'VIDEO' });
    expect(out).toMatchObject({ moduleId: 'm1', position: 1, type: 'VIDEO' });
  });

  it('addLesson 404s when the module is not in the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.courseModule.findFirst.mockResolvedValue(null as any);
    await expect(svc.addLesson(WS, 'ghost', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get 404s a course from another workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue(null as any);
    await expect(svc.get(WS, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});
