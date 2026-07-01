import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  // The progress recompute runs inside an advisory-locked $transaction; run the
  // callback against the same mock and stub the raw lock SELECT.
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.$queryRawUnsafe as any).mockResolvedValue([{ locked: 'x' }]);
  const certificates = { issueForEnrollment: jest.fn().mockResolvedValue(null), getForEnrollment: jest.fn() };
  const gamification = { award: jest.fn().mockResolvedValue(undefined) };
  return { prisma, certificates, gamification, svc: new EnrollmentService(prisma as any, certificates as any, gamification as any) };
}

/** A course shape for courseLessons() — modules→lessons in order. */
function course(dripMode: string | null, lessons: any[]) {
  return { dripMode, modules: [{ lessons }] };
}

describe('EnrollmentService', () => {
  it('enrolls a lead (idempotent upsert) after asserting the course AND the lead', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
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

  it('404s enrolling a lead that belongs to another workspace (no cross-tenant enroll)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.course.findFirst.mockResolvedValue({ id: 'c1' } as any);
    prisma.lead.findFirst.mockResolvedValue(null as any); // lead not in this workspace
    await expect(svc.enroll(WS, 'c1', 'foreign-lead')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.enrollment.upsert).not.toHaveBeenCalled();
  });

  it('marks a lesson complete and recomputes progress to 50% (stays ACTIVE)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as any);
    // ungated 2-lesson course → completing l1 of {l1,l2} = 50%
    prisma.course.findUnique.mockResolvedValue(course(null, [
      { id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null },
      { id: 'l2', position: 1, isPreview: false, gating: 'FREE', dripDays: null },
    ]) as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    // Authoritative post-upsert count over the 2 live lessons: only l1 done.
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l1');
    expect(out).toMatchObject({ progressPct: 50, status: 'ACTIVE', completedAt: null });
  });

  it('flips to COMPLETED at 100% and issues a certificate + awards points', async () => {
    const { prisma, certificates, gamification, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', leadId: 'lead-1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l2' } as any);
    prisma.course.findUnique.mockResolvedValue(course(null, [{ id: 'l2', position: 0, isPreview: false, gating: 'FREE', dripDays: null }]) as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    // Single-lesson course → the one live lesson (l2) is now done → 1/1 = 100%.
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'lead-1', ...a.data }));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l2');
    expect(out.progressPct).toBe(100);
    expect(out.status).toBe('COMPLETED');
    expect(out.completedAt).toBeInstanceOf(Date);
    expect(certificates.issueForEnrollment).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', courseId: 'c1' }));
    // both the lesson and the course-completion awards fire
    expect(gamification.award).toHaveBeenCalledWith(WS, 'lead-1', 'LESSON_COMPLETE', 'l2');
    expect(gamification.award).toHaveBeenCalledWith(WS, 'lead-1', 'COURSE_COMPLETE', 'c1');
  });

  // Concurrency: two lessons of the same enrollment completed near-simultaneously.
  // The recompute must reflect the AUTHORITATIVE live completed set (re-counted
  // after this request's own upsert), NOT a pre-upsert snapshot that omits a
  // sibling's just-committed completion. Otherwise the final pair each write
  // <100%, the enrollment sticks below COMPLETED forever (no later completion to
  // recompute) and the certificate is never issued.
  it('recomputes from the authoritative post-upsert set, not a stale pre-read snapshot', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', leadId: 'lead-1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l3' } as any);
    prisma.course.findUnique.mockResolvedValue(course(null, [
      { id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null },
      { id: 'l2', position: 1, isPreview: false, gating: 'FREE', dripDays: null },
      { id: 'l3', position: 2, isPreview: false, gating: 'FREE', dripDays: null },
    ]) as any);
    // Gating pre-read is a STALE snapshot: only l1 is visible; a concurrent
    // sibling has completed l2 but its write isn't in this snapshot.
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([{ lessonId: 'l1' }]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    // Authoritative post-upsert count over the LIVE lessons: l1 + l2 (sibling) +
    // l3 (this request) = all 3 done.
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(3);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'lead-1', ...a.data }));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l3');
    // A stale-snapshot recompute would see only {l1,l3} → 67%/ACTIVE and never
    // issue the certificate. The fresh count sees all 3 → 100%/COMPLETED.
    expect(out.progressPct).toBe(100);
    expect(out.status).toBe('COMPLETED');
    expect(certificates.issueForEnrollment).toHaveBeenCalled();
  });

  it('does not issue a certificate below 100%', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as any);
    prisma.course.findUnique.mockResolvedValue(course(null, [
      { id: 'l1', position: 0, isPreview: false, gating: 'FREE', dripDays: null },
      { id: 'l2', position: 1, isPreview: false, gating: 'FREE', dripDays: null },
    ]) as any);
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    // 1 of 2 live lessons done → 50%, below the certificate threshold.
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));
    await svc.markLessonComplete(WS, 'e1', 'l1');
    expect(certificates.issueForEnrollment).not.toHaveBeenCalled();
  });

  it('ignores orphaned progress (deleted lessons) — no premature COMPLETED/certificate', async () => {
    const { prisma, certificates, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1', leadId: 'lead-1', enrolledAt: new Date('2026-06-01') } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l4' } as any);
    // The course now has only l4 + l5; l1..l3 were DELETED but their completed
    // LessonProgress rows linger (soft ref, no FK cascade).
    prisma.course.findUnique.mockResolvedValue(
      course(null, [
        { id: 'l4', position: 0, isPreview: false, gating: 'FREE', dripDays: null },
        { id: 'l5', position: 1, isPreview: false, gating: 'FREE', dripDays: null },
      ]) as any,
    );
    // Completed set carries 3 orphans (l1..l3) for lessons no longer in the course.
    (prisma.lessonProgress.findMany as jest.Mock).mockResolvedValue([
      { lessonId: 'l1' }, { lessonId: 'l2' }, { lessonId: 'l3' },
    ]);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    // The recompute count is scoped `lessonId: { in: [l4, l5] }`, so orphaned
    // completions for deleted lessons (l1..l3) are excluded at the DB level — only
    // l4 is a completed LIVE lesson → 1/2 = 50%, not a premature COMPLETED.
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l4');
    // Only l4 (of the live l4/l5) is done → 50%, still ACTIVE, no certificate.
    expect(out.progressPct).toBe(50);
    expect(out.status).toBe('ACTIVE');
    expect(out.completedAt).toBeNull();
    expect(certificates.issueForEnrollment).not.toHaveBeenCalled();
    // The recount is scoped to the LIVE lessons only (orphans excluded in-DB).
    expect((prisma.lessonProgress.count as jest.Mock).mock.calls[0][0].where).toMatchObject({
      enrollmentId: 'e1',
      completed: true,
      lessonId: { in: ['l4', 'l5'] },
    });
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
