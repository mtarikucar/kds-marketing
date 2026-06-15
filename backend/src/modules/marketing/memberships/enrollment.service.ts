import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Epic C2 — enrolls Leads (contacts) into courses and tracks lesson progress.
 * `progressPct` is recomputed from LessonProgress on each completion and the
 * enrollment flips to COMPLETED at 100%. All access is workspace-scoped.
 */
@Injectable()
export class EnrollmentService {
  constructor(private prisma: PrismaService) {}

  private async assertCourse(workspaceId: string, courseId: string) {
    const c = await this.prisma.course.findFirst({
      where: { id: courseId, workspaceId },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Course not found');
  }

  async enroll(workspaceId: string, courseId: string, leadId: string) {
    await this.assertCourse(workspaceId, courseId);
    return this.prisma.enrollment.upsert({
      where: { courseId_leadId: { courseId, leadId } },
      create: { workspaceId, courseId, leadId },
      update: {},
    });
  }

  list(workspaceId: string, filter: { courseId?: string; leadId?: string }) {
    return this.prisma.enrollment.findMany({
      where: {
        workspaceId,
        ...(filter.courseId && { courseId: filter.courseId }),
        ...(filter.leadId && { leadId: filter.leadId }),
      },
      orderBy: { enrolledAt: 'desc' },
    });
  }

  private async assertEnrollment(workspaceId: string, id: string) {
    const e = await this.prisma.enrollment.findFirst({ where: { id, workspaceId } });
    if (!e) throw new NotFoundException('Enrollment not found');
    return e;
  }

  async getProgress(workspaceId: string, id: string) {
    const enrollment = await this.assertEnrollment(workspaceId, id);
    const progress = await this.prisma.lessonProgress.findMany({
      where: { enrollmentId: id },
    });
    return { ...enrollment, progress };
  }

  async unenroll(workspaceId: string, id: string) {
    await this.assertEnrollment(workspaceId, id);
    await this.prisma.enrollment.delete({ where: { id } });
    return { id };
  }

  async markLessonComplete(workspaceId: string, id: string, lessonId: string) {
    const enrollment = await this.assertEnrollment(workspaceId, id);
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, module: { courseId: enrollment.courseId } },
      select: { id: true },
    });
    if (!lesson) {
      throw new BadRequestException("Lesson is not part of this enrollment's course");
    }
    await this.prisma.lessonProgress.upsert({
      where: { enrollmentId_lessonId: { enrollmentId: id, lessonId } },
      create: { enrollmentId: id, lessonId, completed: true, completedAt: new Date() },
      update: { completed: true, completedAt: new Date() },
    });
    const total = await this.prisma.lesson.count({
      where: { module: { courseId: enrollment.courseId } },
    });
    const done = await this.prisma.lessonProgress.count({
      where: { enrollmentId: id, completed: true },
    });
    const pct = total ? Math.round((done / total) * 100) : 0;
    const completed = pct >= 100;
    return this.prisma.enrollment.update({
      where: { id },
      data: {
        progressPct: pct,
        status: completed ? 'COMPLETED' : 'ACTIVE',
        completedAt: completed ? new Date() : null,
      },
    });
  }
}
