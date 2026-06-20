import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreatePipelineDto,
  UpdatePipelineDto,
  CreateStageDto,
  UpdateStageDto,
} from '../dto/opportunity.dto';

/**
 * Pipelines + stages — the kanban scaffolding Opportunities move through
 * (GoHighLevel parity). A workspace may define many named pipelines; each is an
 * ordered list of stages. One pipeline is flagged `isDefault` (where new deals
 * land). A brand-new workspace is lazily seeded a "Sales Pipeline" with sensible
 * default stages the first time it reads, so the board is never empty.
 *
 * Every row is workspace-owned: `workspaceId` is inlined into every multi-row /
 * create query so no read or write can ever cross a tenant boundary. Id-keyed
 * single-row update/delete are resolved through a scoped read first.
 */
@Injectable()
export class PipelinesService {
  private readonly logger = new Logger(PipelinesService.name);

  /** Seeded into a new workspace's default pipeline (name, win-prob, terminal). */
  private static readonly DEFAULT_STAGES: ReadonlyArray<{
    name: string;
    probability: number;
    isWon?: boolean;
    isLost?: boolean;
  }> = [
    { name: 'New', probability: 10 },
    { name: 'Contacted', probability: 25 },
    { name: 'Qualified', probability: 50 },
    { name: 'Proposal Sent', probability: 70 },
    { name: 'Won', probability: 100, isWon: true },
    { name: 'Lost', probability: 0, isLost: true },
  ];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return the workspace's default (or first) active pipeline, seeding one the
   * first time it's needed so the kanban board is usable out of the box.
   */
  async ensureDefaultPipeline(workspaceId: string) {
    const existing = await this.prisma.pipeline.findFirst({
      where: { workspaceId, archived: false },
      orderBy: [{ isDefault: 'desc' }, { position: 'asc' }],
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    if (existing) return existing;

    return this.prisma.pipeline.create({
      data: {
        workspaceId,
        name: 'Sales Pipeline',
        isDefault: true,
        position: 0,
        stages: {
          create: PipelinesService.DEFAULT_STAGES.map((s, i) => ({
            workspaceId,
            name: s.name,
            position: i,
            probability: s.probability,
            isWon: s.isWon ?? false,
            isLost: s.isLost ?? false,
          })),
        },
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  }

  async list(workspaceId: string) {
    // Seed-on-first-read so a fresh workspace always has at least one pipeline.
    await this.ensureDefaultPipeline(workspaceId);
    return this.prisma.pipeline.findMany({
      where: { workspaceId, archived: false },
      orderBy: [{ isDefault: 'desc' }, { position: 'asc' }],
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  }

  async get(workspaceId: string, id: string) {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id, workspaceId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    if (!pipeline) throw new NotFoundException('Pipeline not found');
    return pipeline;
  }

  async create(workspaceId: string, dto: CreatePipelineDto) {
    const stages = dto.stages?.length ? dto.stages : PipelinesService.DEFAULT_STAGES;
    return this.prisma.$transaction(async (tx) => {
      // Only one default per workspace.
      if (dto.isDefault) {
        await tx.pipeline.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.pipeline.create({
        data: {
          workspaceId,
          name: dto.name,
          position: dto.position ?? 0,
          isDefault: dto.isDefault ?? false,
          stages: {
            create: stages.map((s, i) => ({
              workspaceId,
              name: s.name,
              position: s.position ?? i,
              probability: s.probability ?? 0,
              isWon: s.isWon ?? false,
              isLost: s.isLost ?? false,
            })),
          },
        },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
    });
  }

  async update(workspaceId: string, id: string, dto: UpdatePipelineDto) {
    await this.get(workspaceId, id); // scoped existence check
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.pipeline.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.pipeline.update({
        where: { id },
        data: {
          name: dto.name,
          position: dto.position,
          isDefault: dto.isDefault,
          archived: dto.archived,
        },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    // Don't orphan live work: refuse while open deals remain on this pipeline.
    const open = await this.prisma.opportunity.count({
      where: { workspaceId, pipelineId: id, status: 'OPEN' },
    });
    if (open > 0) {
      throw new ConflictException(
        'Pipeline has open opportunities — move or close them first',
      );
    }
    await this.prisma.pipeline.delete({ where: { id } });
    return { message: 'Pipeline deleted' };
  }

  async addStage(workspaceId: string, pipelineId: string, dto: CreateStageDto) {
    await this.get(workspaceId, pipelineId); // scoped existence check
    const count = await this.prisma.pipelineStage.count({
      where: { workspaceId, pipelineId },
    });
    return this.prisma.pipelineStage.create({
      data: {
        workspaceId,
        pipelineId,
        name: dto.name,
        position: dto.position ?? count,
        probability: dto.probability ?? 0,
        isWon: dto.isWon ?? false,
        isLost: dto.isLost ?? false,
      },
    });
  }

  async updateStage(
    workspaceId: string,
    pipelineId: string,
    stageId: string,
    dto: UpdateStageDto,
  ) {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { id: stageId, workspaceId, pipelineId },
    });
    if (!stage) throw new NotFoundException('Stage not found');
    return this.prisma.pipelineStage.update({
      where: { id: stageId },
      data: {
        name: dto.name,
        position: dto.position,
        probability: dto.probability,
        isWon: dto.isWon,
        isLost: dto.isLost,
      },
    });
  }

  async removeStage(workspaceId: string, pipelineId: string, stageId: string) {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { id: stageId, workspaceId, pipelineId },
    });
    if (!stage) throw new NotFoundException('Stage not found');
    const used = await this.prisma.opportunity.count({
      where: { workspaceId, stageId },
    });
    if (used > 0) {
      throw new ConflictException('Stage has opportunities — move them first');
    }
    const remaining = await this.prisma.pipelineStage.count({
      where: { workspaceId, pipelineId },
    });
    if (remaining <= 1) {
      throw new ConflictException('A pipeline must keep at least one stage');
    }
    await this.prisma.pipelineStage.delete({ where: { id: stageId } });
    return { message: 'Stage deleted' };
  }

  async reorderStages(workspaceId: string, pipelineId: string, stageIds: string[]) {
    await this.get(workspaceId, pipelineId);
    const stages = await this.prisma.pipelineStage.findMany({
      where: { workspaceId, pipelineId },
      select: { id: true },
    });
    const known = new Set(stages.map((s) => s.id));
    const unique = new Set(stageIds);
    if (
      stageIds.length !== stages.length ||
      unique.size !== stageIds.length ||
      stageIds.some((id) => !known.has(id))
    ) {
      throw new BadRequestException(
        'stageIds must list every stage of the pipeline exactly once',
      );
    }
    await this.prisma.$transaction(
      stageIds.map((id, i) =>
        this.prisma.pipelineStage.updateMany({
          where: { id, workspaceId, pipelineId },
          data: { position: i },
        }),
      ),
    );
    return this.get(workspaceId, pipelineId);
  }
}
