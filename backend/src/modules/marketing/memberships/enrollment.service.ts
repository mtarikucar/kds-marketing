import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveLessonAccess, AccessLesson } from './lesson-access';
import { CertificateService } from './certificate.service';
import { GamificationService } from './gamification.service';

/** Single-quote a lock key for the raw advisory-lock SELECT. */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/**
 * Epic C2 — enrolls Leads (contacts) into courses and tracks lesson progress.
 * `progressPct` is recomputed from LessonProgress on each completion and the
 * enrollment flips to COMPLETED at 100%. All access is workspace-scoped.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private prisma: PrismaService,
    private readonly certificates: CertificateService,
    private readonly gamification: GamificationService,
  ) {}

  private async assertCourse(workspaceId: string, courseId: string) {
    const c = await this.prisma.course.findFirst({
      where: { id: courseId, workspaceId },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Course not found');
  }

  /** The leadId comes from the request body — verify it belongs to this
   *  workspace so one tenant can't enroll (and mint certificates for) another
   *  tenant's contact. Mirrors wallet/compliance/tags services. */
  private async assertLead(workspaceId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, workspaceId }, select: { id: true } });
    if (!lead) throw new NotFoundException('Contact not found');
  }

  async enroll(workspaceId: string, courseId: string, leadId: string) {
    await this.assertCourse(workspaceId, courseId);
    await this.assertLead(workspaceId, leadId);
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

  /**
   * Course lessons in play order (module.position, then lesson.position) with
   * the fields gating needs, plus the course's drip-mode default.
   */
  private async courseLessons(courseId: string): Promise<{ dripMode: string | null; ordered: AccessLesson[] }> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        dripMode: true,
        // Same id tiebreaker as CoursesService.get: tied legacy positions must
        // resolve to the SAME order the editor renders, or the SEQUENTIAL gate
        // 403s the lesson the UI shows as next.
        modules: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            lessons: {
              orderBy: [{ position: 'asc' }, { id: 'asc' }],
              select: { id: true, position: true, isPreview: true, gating: true, dripDays: true },
            },
          },
        },
      },
    });
    const ordered: AccessLesson[] = (course?.modules ?? []).flatMap((m) => m.lessons);
    return { dripMode: course?.dripMode ?? null, ordered };
  }

  async getProgress(workspaceId: string, id: string) {
    const enrollment = await this.assertEnrollment(workspaceId, id);
    const progress = await this.prisma.lessonProgress.findMany({
      where: { enrollmentId: id },
    });
    const { dripMode, ordered } = await this.courseLessons(enrollment.courseId);
    const completed = new Set(progress.filter((p) => p.completed).map((p) => p.lessonId));
    // Per-lesson access state for the member view — lock badges + unlock dates.
    const lessons = ordered.map((l) => {
      const access = resolveLessonAccess(l, ordered, completed, dripMode, enrollment.enrolledAt);
      return {
        lessonId: l.id,
        completed: completed.has(l.id),
        locked: access.locked,
        unlockAt: access.unlockAt,
        lockReason: access.reason,
      };
    });
    return { ...enrollment, progress, lessons };
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
    // Drip / gating: a locked lesson can't be completed (no skipping a sequential
    // gate or jumping ahead of a drip release). Resolve against the same ordered
    // list + completed set the progress view uses.
    const { dripMode, ordered } = await this.courseLessons(enrollment.courseId);
    const doneRows = await this.prisma.lessonProgress.findMany({
      where: { enrollmentId: id, completed: true },
      select: { lessonId: true },
    });
    const completedSet = new Set(doneRows.map((p) => p.lessonId));
    const target = ordered.find((l) => l.id === lessonId);
    if (target) {
      const access = resolveLessonAccess(target, ordered, completedSet, dripMode, enrollment.enrolledAt);
      if (access.locked) {
        throw new ForbiddenException(
          access.reason === 'DRIP'
            ? 'This lesson is not unlocked yet'
            : 'Complete the previous lesson first',
        );
      }
    }
    // Persist this completion and recompute progress under a per-enrollment
    // advisory lock, re-counting the LIVE completed set FRESH after the upsert.
    // Two lessons of the same enrollment completed concurrently would otherwise
    // each recompute from a pre-upsert snapshot that omits the sibling's just-
    // committed completion — the FINAL pair would both write <100%, leaving the
    // enrollment permanently stuck below COMPLETED (there is no later completion
    // to trigger a recompute), so the certificate is never issued. Serializing +
    // re-counting makes the last writer observe every completion. (Mirrors the
    // ai-credits / message-quota advisory-lock pattern.)
    //
    // The recount is scoped to `lessonId: { in: live }` because
    // LessonProgress.lessonId is a soft ref (no FK cascade to Lesson): deleting a
    // lesson orphans its completed rows, and counting those would inflate `done`
    // past `total`, flipping COMPLETED — minting a certificate — before the
    // remaining lessons are finished. The filter counts only completions for
    // lessons that still exist.
    const live = ordered.map((l) => l.id);
    const total = live.length;
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('enrollment-progress:' + id)}))::text AS locked`,
      );
      await tx.lessonProgress.upsert({
        where: { enrollmentId_lessonId: { enrollmentId: id, lessonId } },
        create: { enrollmentId: id, lessonId, completed: true, completedAt: new Date() },
        update: { completed: true, completedAt: new Date() },
      });
      const done = total
        ? await tx.lessonProgress.count({
            where: { enrollmentId: id, completed: true, lessonId: { in: live } },
          })
        : 0;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const isComplete = pct >= 100;
      return tx.enrollment.update({
        where: { id },
        data: {
          progressPct: pct,
          status: isComplete ? 'COMPLETED' : 'ACTIVE',
          completedAt: isComplete ? new Date() : null,
        },
      });
    });
    const completed = updated.status === 'COMPLETED';
    // Gamification (Epic 10c) — award points; idempotent per (lead, source, ref),
    // so re-completing a lesson can't double-award. Best-effort.
    try {
      await this.gamification.award(workspaceId, enrollment.leadId, 'LESSON_COMPLETE', lessonId);
      if (completed) {
        await this.gamification.award(workspaceId, enrollment.leadId, 'COURSE_COMPLETE', enrollment.courseId);
      }
    } catch (e: any) {
      this.logger.warn(`gamification award failed for enrollment ${id}: ${e?.message ?? e}`);
    }

    // Course completion → issue a certificate if the course has them enabled.
    // Idempotent + best-effort: a failure here must not undo the lesson progress.
    if (completed) {
      try {
        await this.certificates.issueForEnrollment(updated);
      } catch (e: any) {
        this.logger.warn(`certificate issuance failed for enrollment ${id}: ${e?.message ?? e}`);
      }
    }
    return updated;
  }
}
