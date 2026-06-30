import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CertificateService } from './certificate.service';

interface CreateCourseInput {
  title: string;
  slug?: string;
  description?: string;
  priceCents?: number;
  currency?: string;
  coverImageUrl?: string;
}
interface UpdateCourseInput {
  title?: string;
  description?: string;
  priceCents?: number | null;
  currency?: string;
  coverImageUrl?: string;
  status?: string;
  dripMode?: string | null;
  certificateEnabled?: boolean;
  certificateTemplate?: { title?: string; signature?: string; logoUrl?: string } | null;
}
interface LessonInput {
  title?: string;
  type?: string;
  content?: string;
  videoUrl?: string;
  durationSec?: number;
  isPreview?: boolean;
  gating?: string;
  dripDays?: number | null;
}

/**
 * Epic C1 — workspace-authored courses with nested modules → lessons. All
 * module/lesson access is scoped to the workspace by resolving through the
 * owning course (Prisma relation filters), so no cross-workspace leak.
 */
@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private prisma: PrismaService,
    private readonly certificates: CertificateService,
  ) {}

  private slugify(s: string): string {
    return (
      s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) ||
      'course'
    );
  }

  list(workspaceId: string) {
    return this.prisma.course.findMany({
      where: { workspaceId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(workspaceId: string, dto: CreateCourseInput) {
    const slug = dto.slug ?? this.slugify(dto.title);
    const dupe = await this.prisma.course.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
    if (dupe) throw new ConflictException(`Course slug "${slug}" already exists`);
    try {
      return await this.prisma.course.create({
        data: {
          workspaceId,
          title: dto.title,
          slug,
          description: dto.description,
          priceCents: dto.priceCents,
          currency: dto.currency,
          coverImageUrl: dto.coverImageUrl,
        },
      });
    } catch (e) {
      // The dup pre-check above is racy; the (workspaceId, slug) unique is the
      // real guard. Map a concurrent same-slug insert to a clean 409, not a 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException(`Course slug "${slug}" already exists`);
      }
      throw e;
    }
  }

  async get(workspaceId: string, id: string) {
    const course = await this.prisma.course.findFirst({
      where: { id, workspaceId },
      include: {
        modules: {
          orderBy: { position: 'asc' },
          include: { lessons: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  private async assertCourse(workspaceId: string, id: string) {
    const c = await this.prisma.course.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Course not found');
    return c;
  }

  async update(workspaceId: string, id: string, dto: UpdateCourseInput) {
    const prev = await this.prisma.course.findFirst({
      where: { id, workspaceId },
      select: { id: true, certificateEnabled: true },
    });
    if (!prev) throw new NotFoundException('Course not found');
    const updated = await this.prisma.course.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.priceCents !== undefined && { priceCents: dto.priceCents }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.coverImageUrl !== undefined && { coverImageUrl: dto.coverImageUrl }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.dripMode !== undefined && { dripMode: dto.dripMode }),
        ...(dto.certificateEnabled !== undefined && { certificateEnabled: dto.certificateEnabled }),
        ...(dto.certificateTemplate !== undefined && {
          certificateTemplate: dto.certificateTemplate ?? Prisma.JsonNull,
        }),
      },
    });
    // Turning certificates ON for a course that already has graduates is not
    // retroactive by default — backfill so existing 100%-completers get one too.
    // Fire-and-forget so a large cohort can't stall the PATCH; it's idempotent,
    // and any miss self-heals when the certificate is next viewed (getForEnrollment).
    if (dto.certificateEnabled === true && !prev.certificateEnabled) {
      void this.certificates.backfillForCourse(workspaceId, id).catch(() => undefined);
    }
    return updated;
  }

  async remove(workspaceId: string, id: string) {
    await this.assertCourse(workspaceId, id);
    // Course → Enrollment / Certificate are onDelete:Cascade, so a hard delete
    // erases every student's enrollment + lesson progress AND any issued
    // Certificate (a serial-numbered, publicly-verifiable credential). Refuse
    // once anyone has enrolled and point the operator at ARCHIVED status — the
    // soft-delete that hides the course while preserving those records.
    const enrolled = await this.prisma.enrollment.count({
      where: { workspaceId, courseId: id },
    });
    if (enrolled > 0) {
      throw new ConflictException(
        'Course has enrollments — set it to ARCHIVED instead of deleting ' +
          '(deleting would erase student progress and issued certificates)',
      );
    }
    await this.prisma.course.delete({ where: { id } });
    return { id };
  }

  async publish(workspaceId: string, id: string) {
    await this.assertCourse(workspaceId, id);
    const lessons = await this.prisma.lesson.count({
      where: { module: { courseId: id } },
    });
    if (lessons === 0) {
      throw new BadRequestException('A course needs at least one lesson to publish');
    }
    return this.prisma.course.update({ where: { id }, data: { status: 'PUBLISHED' } });
  }

  // ---- modules ----------------------------------------------------------

  async addModule(workspaceId: string, courseId: string, title: string) {
    await this.assertCourse(workspaceId, courseId);
    const position = await this.prisma.courseModule.count({ where: { courseId } });
    return this.prisma.courseModule.create({ data: { courseId, title, position } });
  }

  private async assertModule(workspaceId: string, moduleId: string) {
    const m = await this.prisma.courseModule.findFirst({
      where: { id: moduleId, course: { workspaceId } },
      select: { id: true, courseId: true },
    });
    if (!m) throw new NotFoundException('Module not found');
    return m;
  }

  async updateModule(workspaceId: string, moduleId: string, title: string) {
    await this.assertModule(workspaceId, moduleId);
    return this.prisma.courseModule.update({ where: { id: moduleId }, data: { title } });
  }

  async removeModule(workspaceId: string, moduleId: string) {
    const m = await this.assertModule(workspaceId, moduleId);
    // Deleting the module cascade-deletes its lessons (FK), but LessonProgress is
    // keyed by lessonId with NO FK to Lesson, so those rows would orphan and keep
    // counting toward done/total on every enrollment that completed them. Clear
    // the progress for the module's lessons in the same transaction.
    const lessons = await this.prisma.lesson.findMany({
      where: { moduleId },
      select: { id: true },
    });
    const lessonIds = lessons.map((l) => l.id);
    await this.prisma.$transaction([
      this.prisma.lessonProgress.deleteMany({ where: { lessonId: { in: lessonIds } } }),
      this.prisma.courseModule.delete({ where: { id: moduleId } }),
    ]);
    // The module's lessons are gone — re-derive every enrollment's stored progress
    // (and graduate anyone now at 100% over the remaining lessons).
    await this.recomputeCourseProgress(m.courseId);
    return { id: moduleId };
  }

  async reorderModules(workspaceId: string, courseId: string, ids: string[]) {
    await this.assertCourse(workspaceId, courseId);
    await this.prisma.$transaction(
      ids.map((id, i) =>
        this.prisma.courseModule.updateMany({ where: { id, courseId }, data: { position: i } }),
      ),
    );
    return this.get(workspaceId, courseId);
  }

  // ---- lessons ----------------------------------------------------------

  async addLesson(workspaceId: string, moduleId: string, dto: LessonInput) {
    await this.assertModule(workspaceId, moduleId);
    const position = await this.prisma.lesson.count({ where: { moduleId } });
    return this.prisma.lesson.create({
      data: {
        moduleId,
        title: dto.title ?? 'Untitled lesson',
        type: dto.type ?? 'VIDEO',
        content: dto.content,
        videoUrl: dto.videoUrl,
        durationSec: dto.durationSec,
        isPreview: dto.isPreview ?? false,
        gating: dto.gating ?? 'FREE',
        dripDays: dto.dripDays ?? null,
        position,
      },
    });
  }

  private async assertLesson(workspaceId: string, lessonId: string) {
    const l = await this.prisma.lesson.findFirst({
      where: { id: lessonId, module: { course: { workspaceId } } },
      select: { id: true, module: { select: { courseId: true } } },
    });
    if (!l) throw new NotFoundException('Lesson not found');
    return l;
  }

  /**
   * Re-derive every enrollment's progress after the course's lesson set changes
   * (a lesson or module was removed). `progressPct` is a STORED field — without
   * this it goes stale: removing an INCOMPLETE lesson shrinks the denominator, so
   * a learner who finished all the OTHER lessons is now at 100% but would stay
   * ACTIVE forever (no future markLessonComplete will fire to cross 100% and mint
   * the certificate). Recompute `done/total` over the LIVE lessons only and
   * graduate the ACTIVE enrollments that just reached 100%. Never un-graduate or
   * re-issue a COMPLETED enrollment, and never act on an empty course (total 0).
   */
  private async recomputeCourseProgress(courseId: string) {
    const liveLessons = await this.prisma.lesson.findMany({
      where: { module: { courseId } },
      select: { id: true },
    });
    const liveIds = liveLessons.map((l) => l.id);
    const total = liveIds.length;
    if (total === 0) return;
    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId },
      select: { id: true, workspaceId: true, courseId: true, leadId: true, status: true },
    });
    for (const e of enrollments) {
      const done = await this.prisma.lessonProgress.count({
        where: { enrollmentId: e.id, completed: true, lessonId: { in: liveIds } },
      });
      const pct = Math.round((done / total) * 100);
      // Only an ACTIVE → COMPLETED crossing graduates + issues. A COMPLETED
      // enrollment keeps its status and certificate even if pct is recomputed.
      const graduates = pct >= 100 && e.status !== 'COMPLETED';
      const updated = await this.prisma.enrollment.update({
        where: { id: e.id },
        data: {
          progressPct: pct,
          ...(graduates ? { status: 'COMPLETED', completedAt: new Date() } : {}),
        },
      });
      if (graduates) {
        try {
          await this.certificates.issueForEnrollment(updated);
        } catch (err: any) {
          this.logger.warn(
            `certificate issuance failed for enrollment ${e.id}: ${err?.message ?? err}`,
          );
        }
      }
    }
  }

  async updateLesson(workspaceId: string, lessonId: string, dto: LessonInput) {
    await this.assertLesson(workspaceId, lessonId);
    return this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.videoUrl !== undefined && { videoUrl: dto.videoUrl }),
        ...(dto.durationSec !== undefined && { durationSec: dto.durationSec }),
        ...(dto.isPreview !== undefined && { isPreview: dto.isPreview }),
        ...(dto.gating !== undefined && { gating: dto.gating }),
        ...(dto.dripDays !== undefined && { dripDays: dto.dripDays }),
      },
    });
  }

  async removeLesson(workspaceId: string, lessonId: string) {
    const lesson = await this.assertLesson(workspaceId, lessonId);
    // LessonProgress has no FK to Lesson (only to Enrollment), so deleting the
    // lesson would orphan its progress rows — they keep counting toward done/total,
    // inflating completion (pct can exceed 100% and falsely flip an enrollment to
    // COMPLETED / issue a certificate). Remove the progress in the same transaction.
    await this.prisma.$transaction([
      this.prisma.lessonProgress.deleteMany({ where: { lessonId } }),
      this.prisma.lesson.delete({ where: { id: lessonId } }),
    ]);
    // The course now has one fewer lesson — re-derive every enrollment's stored
    // progress so it isn't stale (and graduate anyone now at 100%).
    await this.recomputeCourseProgress(lesson.module.courseId);
    return { id: lessonId };
  }
}
