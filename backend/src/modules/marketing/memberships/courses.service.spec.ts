import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const certificates = { backfillForCourse: jest.fn().mockResolvedValue(0) };
  return { prisma, certificates, svc: new CoursesService(prisma as any, certificates as any) };
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

  it('backfills certificates when certificateEnabled flips on', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: false } as any);
    (prisma.course.update as jest.Mock).mockResolvedValue({ id: 'c1', certificateEnabled: true });
    await svc.update(WS, 'c1', { certificateEnabled: true });
    expect(certificates.backfillForCourse).toHaveBeenCalledWith(WS, 'c1');
  });

  it('does not backfill when certificates were already enabled', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
    (prisma.course.update as jest.Mock).mockResolvedValue({ id: 'c1', certificateEnabled: true });
    await svc.update(WS, 'c1', { certificateEnabled: true, title: 'X' });
    expect(certificates.backfillForCourse).not.toHaveBeenCalled();
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

  it('removeLesson clears the lesson progress so it cannot orphan (done/total inflation)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as any); // assertLesson
    (prisma.$transaction as any).mockResolvedValue([]);
    (prisma.lessonProgress.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.lesson.delete as jest.Mock).mockResolvedValue({ id: 'l1' });
    await svc.removeLesson(WS, 'l1');
    // LessonProgress has no FK to Lesson, so the progress rows must be deleted
    // explicitly — otherwise they orphan and inflate done/total on enrollments.
    expect(prisma.lessonProgress.deleteMany).toHaveBeenCalledWith({ where: { lessonId: 'l1' } });
  });

  it('removeModule clears progress for all of its lessons before deleting', async () => {
    const { prisma, svc } = makeSvc();
    prisma.courseModule.findFirst.mockResolvedValue({ id: 'm1', courseId: 'c1' } as any); // assertModule
    (prisma.lesson.findMany as jest.Mock).mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
    (prisma.$transaction as any).mockResolvedValue([]);
    (prisma.lessonProgress.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.courseModule.delete as jest.Mock).mockResolvedValue({ id: 'm1' });
    await svc.removeModule(WS, 'm1');
    expect(prisma.lesson.findMany).toHaveBeenCalledWith({ where: { moduleId: 'm1' }, select: { id: true } });
    expect(prisma.lessonProgress.deleteMany).toHaveBeenCalledWith({ where: { lessonId: { in: ['l1', 'l2'] } } });
  });

  it('get 404s a course from another workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue(null as any);
    await expect(svc.get(WS, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  // Course → Enrollment / Certificate are onDelete:Cascade. A hard delete would
  // erase every student's enrollment + lesson progress AND any issued
  // Certificate (a serial-numbered, publicly-verifiable credential). The course
  // must be ARCHIVED instead once anyone has enrolled.
  it('refuses to delete a course that has enrollments (cascade would erase progress + certificates)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any); // assertCourse
    (prisma.enrollment.count as jest.Mock).mockResolvedValue(4);
    await expect(svc.remove(WS, 'c1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.enrollment.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, courseId: 'c1' } }),
    );
    expect(prisma.course.delete).not.toHaveBeenCalled();
  });

  it('deletes a course that has no enrollments', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    (prisma.enrollment.count as jest.Mock).mockResolvedValue(0);
    (prisma.course.delete as jest.Mock).mockResolvedValue({ id: 'c1' });
    await svc.remove(WS, 'c1');
    expect(prisma.course.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });
});
