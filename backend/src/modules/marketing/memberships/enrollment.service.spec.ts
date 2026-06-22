import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const certificates = { issueForEnrollment: jest.fn().mockResolvedValue(null), getForEnrollment: jest.fn() };
  return { prisma, certificates, svc: new EnrollmentService(prisma as any, certificates as any) };
}

/** A course shape for courseLessons() — modules→lessons in order. */
function course(dripMode: string | null, lessons: any[]) {
  return { dripMode, modules: [{ lessons }] };
}

describe('EnrollmentService', () => {
  it('enrolls a lead (idempotent upsert) after asserting the course', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    (prisma.enrollment.upsert as jest.Mock).mockResolvedValue({ id: 'e1', courseId: 'c1', leadId: 'lead-1' });
    const out: any = await svc.enroll(WS, 'c1', 'lead-1');
    expect(out).toMatchObject({ id: 'e1' });
    expect((prisma.enrollment.upsert as jest.Mock).mock.calls[0][0].where).toEqual({ courseId_leadId: { courseId: 'c1', leadId: 'lead-1' } });
  });

  it('404s enrolling into a course from another workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue(null as any);
    await expect(svc.enroll(WS, 'ghost', 'lead-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks a lesson complete and recomputes progress to 50% (stays ACTIVE)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as any);
    // ungated course → no lock check blocks the write
    prisma.course.findUnique.mockResolvedValue(course(null, [{ id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null }]) as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l1');
    expect(out).toMatchObject({ progressPct: 50, status: 'ACTIVE', completedAt: null });
  });

  it('flips to COMPLETED at 100% and issues a certificate', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l2' } as any);
    prisma.course.findUnique.mockResolvedValue(course(null, [{ id: 'l2', position: 0, isPreview: false, gating: 'FREE', dripDays: null }]) as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(2);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'lead-1', ...a.data }));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l2');
    expect(out.progressPct).toBe(100);
    expect(out.status).toBe('COMPLETED');
    expect(out.completedAt).toBeInstanceOf(Date);
    expect(certificates.issueForEnrollment).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', courseId: 'c1' }));
  });

  it('does not issue a certificate below 100%', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as any);
    prisma.course.findUnique.mockResolvedValue(course(null, [{ id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null }]) as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));
    await svc.markLessonComplete(WS, 'e1', 'l1');
    expect(certificates.issueForEnrollment).not.toHaveBeenCalled();
  });

  it('rejects completing a lesson that is not in the enrollment course', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1' } as any);
    prisma.lesson.findFirst.mockResolvedValue(null as any);
    await expect(svc.markLessonComplete(WS, 'e1', 'lx')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('403s completing a SEQUENTIAL lesson whose prior lesson is not done', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l2' } as any);
    prisma.course.findUnique.mockResolvedValue(
      course(null, [
        { id: 'l1', position: 0, isPreview: false, gating: 'SEQUENTIAL', dripDays: null },
        { id: 'l2', position: 1, isPreview: false, gating: 'SEQUENTIAL', dripDays: null },
      ]) as any,
    );
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]); // l1 not completed
    await expect(svc.markLessonComplete(WS, 'e1', 'l2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.lessonProgress.upsert).not.toHaveBeenCalled();
  });

  it('allows completing the SEQUENTIAL lesson once its prior is done', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l2' } as any);
    prisma.course.findUnique.mockResolvedValue(
      course(null, [
        { id: 'l1', position: 0, isPreview: false, gating: 'SEQUENTIAL', dripDays: null },
        { id: 'l2', position: 1, isPreview: false, gating: 'SEQUENTIAL', dripDays: null },
      ]) as any,
    );
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([{ lessonId: 'l1' }]); // l1 done
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(2);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));
    await expect(svc.markLessonComplete(WS, 'e1', 'l2')).resolves.toBeTruthy();
    expect(prisma.lessonProgress.upsert).toHaveBeenCalled();
  });

  it('getProgress annotates each lesson with locked + unlockAt', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([{ lessonId: 'l1', completed: true }]);
    prisma.course.findUnique.mockResolvedValue(
      course(null, [
        { id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null },
        { id: 'l2', position: 1, isPreview: false, gating: 'SEQUENTIAL', dripDays: null },
        { id: 'l3', position: 2, isPreview: false, gating: 'SEQUENTIAL', dripDays: null },
      ]) as any,
    );
    const out: any = await svc.getProgress(WS, 'e1');
    const byId = Object.fromEntries(out.lessons.map((l: any) => [l.lessonId, l]));
    expect(byId.l1).toMatchObject({ completed: true, locked: false });
    expect(byId.l2).toMatchObject({ locked: false }); // prior (l1) done → open
    expect(byId.l3).toMatchObject({ locked: true, lockReason: 'SEQUENTIAL' }); // prior (l2) not done
  });
});
