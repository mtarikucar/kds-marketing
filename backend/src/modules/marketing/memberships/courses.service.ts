import {
  BadRequestException,
  ConflictException,
  Injectable,
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
    return this.prisma.course.create({
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
    await this.assertModule(workspaceId, moduleId);
    await this.prisma.courseModule.delete({ where: { id: moduleId } });
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
      select: { id: true },
    });
    if (!l) throw new NotFoundException('Lesson not found');
    return l;
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
    await this.assertLesson(workspaceId, lessonId);
    await this.prisma.lesson.delete({ where: { id: lessonId } });
    return { id: lessonId };
  }
}
