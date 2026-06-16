import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new EnrollmentService(prisma as any) };
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
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1' } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l1' } as any);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(1);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l1');
    expect(out).toMatchObject({ progressPct: 50, status: 'ACTIVE', completedAt: null });
  });

  it('flips to COMPLETED at 100%', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1' } as any);
    prisma.lesson.findFirst.mockResolvedValue({ id: 'l2' } as any);
    (prisma.lessonProgress.upsert as jest.Mock).mockResolvedValue({});
    (prisma.lesson.count as jest.Mock).mockResolvedValue(2);
    (prisma.lessonProgress.count as jest.Mock).mockResolvedValue(2);
    (prisma.enrollment.update as jest.Mock).mockImplementation((a: any) => Promise.resolve(a.data));

    const out: any = await svc.markLessonComplete(WS, 'e1', 'l2');
    expect(out.progressPct).toBe(100);
    expect(out.status).toBe('COMPLETED');
    expect(out.completedAt).toBeInstanceOf(Date);
  });

  it('rejects completing a lesson that is not in the enrollment course', async () => {
    const { prisma, svc } = makeSvc();
    prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', courseId: 'c1' } as any);
    prisma.lesson.findFirst.mockResolvedValue(null as any);
    await expect(svc.markLessonComplete(WS, 'e1', 'lx')).rejects.toBeInstanceOf(BadRequestException);
  });
});
