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
      include: { stages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
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
      include: { stages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
    });
  }

  async list(workspaceId: string) {
    // Seed-on-first-read so a fresh workspace always has at least one pipeline.
    await this.ensureDefaultPipeline(workspaceId);
    return this.prisma.pipeline.findMany({
      where: { workspaceId, archived: false },
      orderBy: [{ isDefault: 'desc' }, { position: 'asc' }],
      include: { stages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
    });
  }

  async get(workspaceId: string, id: string) {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id, workspaceId },
      include: { stages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
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
        include: { stages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
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
        include: { stages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] } },
      });
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    // Opportunity→Pipeline is onDelete:Cascade, so deleting a pipeline destroys
    // EVERY opportunity on it — including resolved WON/LOST deals that are sales
    // history (reporting, commissions). Guarding only OPEN deals would silently
    // cascade those records away. Refuse while ANY opportunity references the
    // pipeline and point the user at archiving (the soft-delete that hides it
    // from the board while preserving the deals).
    const used = await this.prisma.opportunity.count({
      where: { workspaceId, pipelineId: id },
    });
    if (used > 0) {
      throw new ConflictException(
        'Pipeline has opportunities — archive it instead, or move/delete its deals first',
      );
    }
    await this.prisma.pipeline.delete({ where: { id } });
    return { message: 'Pipeline deleted' };
  }

  async addStage(workspaceId: string, pipelineId: string, dto: CreateStageDto) {
    await this.get(workspaceId, pipelineId); // scoped existence check
    // max+1, NOT count(): removeStage deletes without repacking, so after any
    // deletion the surviving positions are sparse and count() lands on an
    // already-occupied slot — two stages then share a position and the board's
    // `orderBy position asc` renders them in nondeterministic order.
    const agg = await this.prisma.pipelineStage.aggregate({
      where: { workspaceId, pipelineId },
      _max: { position: true },
    });
    const nextPosition = (agg._max.position ?? -1) + 1;
    return this.prisma.pipelineStage.create({
      data: {
        workspaceId,
        pipelineId,
        name: dto.name,
        position: dto.position ?? nextPosition,
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
    // An opportunity's status (OPEN/WON/LOST) is derived from its stage's
    // isWon/isLost flags and only re-synced when the deal MOVES (see
    // OpportunitiesService.move). Flipping those flags on a stage that already
    // holds deals would leave them stranded with a status that no longer matches
    // the stage — e.g. OPEN cards sitting in a now-"won" stage: they'd still show
    // on the board, inflate the forecast, and never count as won in reporting.
    // Refuse while it holds deals (mirrors removeStage's "move them first");
    // name/position/probability stay freely editable.
    const wonChanged = dto.isWon !== undefined && dto.isWon !== stage.isWon;
    const lostChanged = dto.isLost !== undefined && dto.isLost !== stage.isLost;
    if (wonChanged || lostChanged) {
      const used = await this.prisma.opportunity.count({ where: { workspaceId, stageId } });
      if (used > 0) {
        throw new ConflictException(
          'Stage has opportunities — move them before changing its won/lost type',
        );
      }
    }
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
    // Delete AND close the position gap in one transaction so the surviving
    // stages stay a dense 0..n-1 sequence — the next max+1 append can't tie a
    // survivor, and the board ordering stays stable.
    await this.prisma.$transaction([
      this.prisma.pipelineStage.delete({ where: { id: stageId } }),
      this.prisma.pipelineStage.updateMany({
        where: { workspaceId, pipelineId, position: { gt: stage.position } },
        data: { position: { decrement: 1 } },
      }),
    ]);
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
