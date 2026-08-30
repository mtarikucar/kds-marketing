import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { PipelinesService } from './pipelines.service';
import { MarketingUserPayload } from '../types';
import { paginated } from '../../../common/pagination';
import {
  CreateOpportunityDto,
  UpdateOpportunityDto,
  MoveOpportunityDto,
  LoseOpportunityDto,
  OpportunityFilterDto,
} from '../dto/opportunity.dto';
import { DealEvent, dealActivity, personDisplayName } from './opportunity-activity';

/** Round a major-unit money sum to 2dp — float sums of Decimal(12,2) values
 *  drift (e.g. 10×0.10 → 0.9999999999999999), so every surfaced total is rounded. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Opportunities — deals moving across a pipeline's stages on a kanban board
 * (GoHighLevel parity). Status (OPEN/WON/LOST/ABANDONED) is kept in sync with
 * the stage's isWon/isLost flags: dropping a card into a terminal stage resolves
 * the deal and stamps wonAt/lostAt.
 *
 * REP scoping mirrors leads: a rep sees/edits only opportunities assigned to
 * them; managers see the whole workspace. Every multi-row/create query inlines
 * `workspaceId`; id-keyed update/delete go through a scoped read first.
 *
 * Lifecycle events (created / stage_changed / won / lost) are appended to the
 * outbox best-effort so workflow triggers (Epic 2) and reporting can subscribe
 * without coupling to this service.
 */
@Injectable()
export class OpportunitiesService {
  private readonly logger = new Logger(OpportunitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
    private readonly outbox: OutboxService,
  ) {}

  /** Resolve an opportunity in-scope, enforcing REP ownership. */
  private async getScoped(workspaceId: string, id: string, user: MarketingUserPayload) {
    const opp = await this.prisma.opportunity.findFirst({ where: { id, workspaceId } });
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (user.role === 'REP' && opp.assignedToId !== user.id) {
      throw new ForbiddenException('You can only access your own opportunities');
    }
    return opp;
  }

  async get(workspaceId: string, id: string, user: MarketingUserPayload) {
    return this.getScoped(workspaceId, id, user);
  }

  /**
   * The `LeadActivity` row a sales move leaves on the person — or null when
   * there is nobody to leave it on.
   *
   * Built BEFORE the deal's transaction opens and written INSIDE it, so the
   * deal and its trace commit together while the two reads it needs (the person,
   * the stage it came from) stay outside the transaction's lifetime.
   *
   * Two reasons it can answer null, and neither is an error:
   *
   * - the deal has no `leadId` (a walk-in deal nobody is attached to);
   * - the `leadId` does not resolve IN THIS WORKSPACE. `Opportunity.leadId` is a
   *   soft ref with no foreign key (schema.prisma:3931), so it may name a person
   *   who has been deleted — a foreign-key error would then fail the drag itself —
   *   or a person belonging to a NEIGHBOUR, whose timeline must never receive
   *   our deal's name. The scoped read is the only thing standing between the
   *   two workspaces, so it is written here rather than assumed upstream.
   */
  private async dealTrace(
    workspaceId: string,
    opp: {
      id: string;
      leadId: string | null;
      stageId: string;
      name: string;
      value: unknown;
      currency: string;
    },
    event: DealEvent,
    toStage: { id: string; name: string } | null,
    actorId: string,
    reason?: string | null,
  ) {
    if (!opp.leadId) return null;
    const lead = await this.prisma.lead.findFirst({
      where: { id: opp.leadId, workspaceId },
      select: { id: true },
    });
    if (!lead) return null;

    // The stage the card came from, by NAME — ids are unreadable and the title
    // is read by a human. Skipped when the deal is being opened (there is no
    // "from") or when the card did not actually change column, where a title
    // reading "Yeni → Yeni" would be noise.
    const fromStage =
      event === 'opened' || !opp.stageId || opp.stageId === toStage?.id
        ? null
        : await this.prisma.pipelineStage.findFirst({
            where: { id: opp.stageId, workspaceId },
            select: { name: true },
          });

    return {
      ...dealActivity({
        event,
        opportunityId: opp.id,
        dealName: opp.name,
        fromStageId: fromStage ? opp.stageId : null,
        fromStageName: fromStage?.name ?? null,
        toStageId: toStage?.id ?? null,
        toStageName: toStage?.name ?? null,
        value: opp.value === null || opp.value === undefined ? null : Number(opp.value),
        currency: opp.currency,
        reason: reason ?? null,
      }),
      leadId: lead.id,
      createdById: actorId,
    };
  }

  /** Paginated, filtered list. REP is hard-scoped to their own deals. */
  async list(workspaceId: string, filter: OpportunityFilterDto, user: MarketingUserPayload) {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.opportunity.findMany({
        where: {
          workspaceId,
          ...(filter.pipelineId ? { pipelineId: filter.pipelineId } : {}),
          ...(filter.stageId ? { stageId: filter.stageId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.leadId ? { leadId: filter.leadId } : {}),
          ...(user.role === 'REP'
            ? { assignedToId: user.id }
            : filter.assignedToId
              ? { assignedToId: filter.assignedToId }
              : {}),
          ...(filter.search
            ? { name: { contains: filter.search, mode: 'insensitive' as const } }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.opportunity.count({
        where: {
          workspaceId,
          ...(filter.pipelineId ? { pipelineId: filter.pipelineId } : {}),
          ...(filter.stageId ? { stageId: filter.stageId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.leadId ? { leadId: filter.leadId } : {}),
          ...(user.role === 'REP'
            ? { assignedToId: user.id }
            : filter.assignedToId
              ? { assignedToId: filter.assignedToId }
              : {}),
          ...(filter.search
            ? { name: { contains: filter.search, mode: 'insensitive' as const } }
            : {}),
        },
      }),
    ]);

    return paginated(data, total, page, limit);
  }

  /**
   * Kanban board for one pipeline: the ordered stages, each with its OPEN cards
   * (ordered by `position`). REP sees only their own cards.
   */
  async board(workspaceId: string, pipelineId: string | undefined, user: MarketingUserPayload) {
    const pipeline = pipelineId
      ? await this.pipelines.get(workspaceId, pipelineId)
      : await this.pipelines.ensureDefaultPipeline(workspaceId);

    const cards = await this.prisma.opportunity.findMany({
      where: {
        workspaceId,
        pipelineId: pipeline.id,
        status: 'OPEN',
        ...(user.role === 'REP' ? { assignedToId: user.id } : {}),
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    const byStage = new Map<string, typeof cards>();
    for (const card of cards) {
      const list = byStage.get(card.stageId) ?? [];
      list.push(card);
      byStage.set(card.stageId, list);
    }

    return {
      pipeline: { id: pipeline.id, name: pipeline.name, isDefault: pipeline.isDefault },
      stages: pipeline.stages.map((s) => {
        const items = byStage.get(s.id) ?? [];
        const value = round2(items.reduce((sum, o) => sum + Number(o.value), 0));
        // weightedValue = expected value = Σ(value) × stage.probability%. Surfaced
        // alongside the raw total so the board header can show both (GHL parity).
        const weightedValue = Math.round(value * s.probability) / 100;
        return { ...s, opportunities: items, totalValue: value, weightedValue, count: items.length };
      }),
    };
  }

  /**
   * Weighted pipeline forecast (GoHighLevel parity): for the OPEN deals in a
   * pipeline, the per-stage raw and probability-weighted (expected) value, the
   * pipeline totals, and a time-phased breakdown bucketed by expectedCloseDate
   * month. REP sees only their own deals (mirrors board()). Terminal (won/lost)
   * stages are excluded — a resolved deal is no longer "in the forecast".
   *
   * Values are summed in their stored major units without currency conversion
   * (matching board()); a workspace mixing currencies in one pipeline is an
   * existing edge the forecast inherits, surfaced via `currencies`.
   */
  async forecast(workspaceId: string, pipelineId: string | undefined, user: MarketingUserPayload) {
    const pipeline = pipelineId
      ? await this.pipelines.get(workspaceId, pipelineId)
      : await this.pipelines.ensureDefaultPipeline(workspaceId);

    const opps = await this.prisma.opportunity.findMany({
      where: {
        workspaceId,
        pipelineId: pipeline.id,
        status: 'OPEN',
        ...(user.role === 'REP' ? { assignedToId: user.id } : {}),
      },
      select: { stageId: true, value: true, currency: true, expectedCloseDate: true },
    });

    const byStage = new Map<string, typeof opps>();
    const currencies = new Set<string>();
    for (const o of opps) {
      currencies.add(o.currency);
      const list = byStage.get(o.stageId) ?? [];
      list.push(o);
      byStage.set(o.stageId, list);
    }

    const stages = pipeline.stages
      .filter((s) => !s.isWon && !s.isLost)
      .map((s) => {
        const items = byStage.get(s.id) ?? [];
        const rawValue = round2(items.reduce((sum, o) => sum + Number(o.value), 0));
        const weightedValue = Math.round(rawValue * s.probability) / 100;
        return { stageId: s.id, name: s.name, probability: s.probability, count: items.length, rawValue, weightedValue };
      });

    const rawTotal = round2(stages.reduce((sum, s) => sum + s.rawValue, 0));
    const weightedTotal = round2(stages.reduce((sum, s) => sum + s.weightedValue, 0));

    // Time-phased: open deals grouped by expected-close month (YYYY-MM), with an
    // 'unscheduled' bucket for deals without a date.
    const buckets = new Map<string, { month: string; rawValue: number; count: number }>();
    for (const o of opps) {
      const d = o.expectedCloseDate;
      const key = d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : 'unscheduled';
      const b = buckets.get(key) ?? { month: key, rawValue: 0, count: 0 };
      b.rawValue += Number(o.value);
      b.count += 1;
      buckets.set(key, b);
    }
    const months = [...buckets.values()]
      .map((b) => ({ ...b, rawValue: round2(b.rawValue) }))
      .sort((a, b) =>
        a.month === 'unscheduled' ? 1 : b.month === 'unscheduled' ? -1 : a.month.localeCompare(b.month),
      );

    return {
      pipeline: { id: pipeline.id, name: pipeline.name },
      currencies: [...currencies],
      stages,
      rawTotal,
      weightedTotal,
      openCount: opps.length,
      months,
    };
  }

  async create(workspaceId: string, dto: CreateOpportunityDto, user: MarketingUserPayload) {
    const pipeline = dto.pipelineId
      ? await this.pipelines.get(workspaceId, dto.pipelineId)
      : await this.pipelines.ensureDefaultPipeline(workspaceId);

    let stage = dto.stageId
      ? pipeline.stages.find((s) => s.id === dto.stageId)
      : pipeline.stages[0];
    if (dto.stageId && !stage) {
      throw new BadRequestException('stageId does not belong to the pipeline');
    }
    if (!stage) throw new BadRequestException('Pipeline has no stages');

    // A rep may only own their own deals; managers may assign to anyone.
    const assignedToId = user.role === 'REP' ? user.id : dto.assignedToId ?? null;

    let lead: { id: string; businessName: string; contactPerson: string } | null = null;
    if (dto.leadId) {
      lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, workspaceId },
        // The names come back because a deal dragged onto the board FROM the
        // "not in pipeline" column carries no name of its own — see below.
        select: { id: true, businessName: true, contactPerson: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }

    /**
     * Dropping a PERSON onto a stage opens a deal for them, and that gesture
     * supplies no deal name — so the person's own name becomes it. Falling back
     * here rather than making the client invent one keeps a single creation path
     * for both entry points (the "+ Add" form and the drag), which is the whole
     * reason `createOpportunity` already took a `leadId`.
     */
    const name = dto.name?.trim() || (lead ? personDisplayName(lead) : '');
    if (!name) {
      throw new BadRequestException('name is required when the deal has no linked person');
    }

    const now = new Date();
    const status = stage.isWon ? 'WON' : stage.isLost ? 'LOST' : 'OPEN';
    const currency = dto.currency ?? 'TRY';
    // One transaction: the deal and the line it leaves on the person's stream
    // commit together, so the board can never show a deal whose opening left no
    // trace (nor a trace for a deal that failed to open).
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.opportunity.create({
        data: {
          workspaceId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          leadId: dto.leadId ?? null,
          assignedToId,
          name,
          value: dto.value ?? 0,
          currency,
          source: dto.source ?? null,
          notes: dto.notes ?? null,
          expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null,
          status,
          position: 0,
          wonAt: stage.isWon ? now : null,
          lostAt: stage.isLost ? now : null,
        },
      });
      if (lead) {
        await tx.leadActivity.create({
          data: {
            ...dealActivity({
              event: 'opened',
              opportunityId: row.id,
              dealName: name,
              toStageId: stage.id,
              toStageName: stage.name,
              value: dto.value ?? 0,
              currency,
            }),
            leadId: lead.id,
            createdById: user.id,
          },
        });
      }
      return row;
    });

    void this.emit(MarketingEventTypes.OpportunityCreated, `opp-created:${created.id}`, {
      workspaceId,
      opportunityId: created.id,
      pipelineId: created.pipelineId,
      stageId: created.stageId,
      leadId: created.leadId,
      assignedToId: created.assignedToId,
      value: Number(created.value),
      occurredAt: now.toISOString(),
    });
    // A deal born directly on a terminal stage (reachable via the API — the
    // kanban never offers "+ Add" on a Won/Lost column) must ALSO fire its
    // won/lost event, matching move()/win()/lose(). Without this a born-resolved
    // deal enters won/lost REPORTING while skipping every won/lost AUTOMATION
    // (the won-trigger workflow, Meta CAPI conversion).
    if (status === 'WON') {
      void this.emit(MarketingEventTypes.OpportunityWon, `opp-won:${created.id}`, {
        workspaceId,
        opportunityId: created.id,
        leadId: created.leadId,
        value: Number(created.value),
        occurredAt: now.toISOString(),
      });
    } else if (status === 'LOST') {
      void this.emit(MarketingEventTypes.OpportunityLost, `opp-lost:${created.id}`, {
        workspaceId,
        opportunityId: created.id,
        leadId: created.leadId,
        reason: null,
        occurredAt: now.toISOString(),
      });
    }
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateOpportunityDto,
    user: MarketingUserPayload,
  ) {
    await this.getScoped(workspaceId, id, user);

    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, workspaceId },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }

    return this.prisma.opportunity.update({
      where: { id },
      data: {
        name: dto.name,
        value: dto.value,
        currency: dto.currency,
        source: dto.source,
        notes: dto.notes,
        leadId: dto.leadId,
        // undefined = leave as-is; null clears the date; a string sets it.
        expectedCloseDate:
          dto.expectedCloseDate === undefined
            ? undefined
            : dto.expectedCloseDate === null
              ? null
              : new Date(dto.expectedCloseDate),
        // Reps cannot reassign; only managers may change ownership.
        assignedToId: user.role === 'REP' ? undefined : dto.assignedToId,
      },
    });
  }

  /** Move a card to another stage (+ position) — the kanban drag-and-drop op. */
  async move(
    workspaceId: string,
    id: string,
    dto: MoveOpportunityDto,
    user: MarketingUserPayload,
  ) {
    const opp = await this.getScoped(workspaceId, id, user);
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { id: dto.stageId, workspaceId, pipelineId: opp.pipelineId },
    });
    if (!stage) throw new NotFoundException('Stage not found in this pipeline');

    const now = new Date();
    const status = stage.isWon ? 'WON' : stage.isLost ? 'LOST' : 'OPEN';
    // A card reordered inside its own column is not news; only a real column
    // change earns a line in the person's stream. A drop on the win/lost column
    // reads as WON/LOST rather than as a stage move — landing there IS the
    // outcome, and two rows for one gesture would just be noise.
    const trace =
      opp.stageId !== stage.id
        ? await this.dealTrace(
            workspaceId,
            opp,
            status === 'WON' ? 'won' : status === 'LOST' ? 'lost' : 'stage_changed',
            stage,
            user.id,
            opp.lostReason,
          )
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.opportunity.update({
        where: { id },
        data: {
          stageId: stage.id,
          position: dto.position ?? 0,
          status,
          wonAt: stage.isWon ? opp.wonAt ?? now : null,
          lostAt: stage.isLost ? opp.lostAt ?? now : null,
        },
      });
      if (trace) await tx.leadActivity.create({ data: trace });
      return row;
    });

    if (opp.stageId !== stage.id) {
      void this.emit(
        MarketingEventTypes.OpportunityStageChanged,
        `opp-stage:${id}:${stage.id}:${now.getTime()}`,
        {
          workspaceId,
          opportunityId: id,
          leadId: opp.leadId,
          pipelineId: opp.pipelineId,
          fromStageId: opp.stageId,
          toStageId: stage.id,
          status,
          occurredAt: now.toISOString(),
        },
      );
      if (status === 'WON') {
        void this.emit(MarketingEventTypes.OpportunityWon, `opp-won:${id}`, {
          workspaceId,
          opportunityId: id,
          leadId: opp.leadId,
          value: Number(updated.value),
          occurredAt: now.toISOString(),
        });
      } else if (status === 'LOST') {
        void this.emit(MarketingEventTypes.OpportunityLost, `opp-lost:${id}`, {
          workspaceId,
          opportunityId: id,
          leadId: opp.leadId,
          occurredAt: now.toISOString(),
        });
      }
    }
    return updated;
  }

  /** Resolve a deal as WON (moves it to the pipeline's win stage if one exists). */
  async win(workspaceId: string, id: string, user: MarketingUserPayload) {
    const opp = await this.getScoped(workspaceId, id, user);
    const winStage = await this.prisma.pipelineStage.findFirst({
      where: { workspaceId, pipelineId: opp.pipelineId, isWon: true },
      orderBy: { position: 'asc' },
    });
    const now = new Date();
    const trace = await this.dealTrace(workspaceId, opp, 'won', winStage, user.id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.opportunity.update({
        where: { id },
        data: {
          status: 'WON',
          wonAt: now,
          lostAt: null,
          ...(winStage ? { stageId: winStage.id } : {}),
        },
      });
      if (trace) await tx.leadActivity.create({ data: trace });
      return row;
    });
    // Moving into the win stage is a stage change too — emit StageChanged so the
    // "opportunity.stage_changed" workflow trigger (the workhorse) fires the SAME
    // whether the deal is won via THIS button or dragged into the win stage via
    // move(). Without this, a stage-entry automation silently fired only on drag.
    if (winStage && opp.stageId !== winStage.id) {
      void this.emit(
        MarketingEventTypes.OpportunityStageChanged,
        `opp-stage:${id}:${winStage.id}:${now.getTime()}`,
        {
          workspaceId,
          opportunityId: id,
          leadId: opp.leadId,
          pipelineId: opp.pipelineId,
          fromStageId: opp.stageId,
          toStageId: winStage.id,
          status: 'WON',
          occurredAt: now.toISOString(),
        },
      );
    }
    void this.emit(MarketingEventTypes.OpportunityWon, `opp-won:${id}`, {
      workspaceId,
      opportunityId: id,
      leadId: opp.leadId,
      value: Number(updated.value),
      occurredAt: now.toISOString(),
    });
    return updated;
  }

  /** Resolve a deal as LOST with an optional reason. */
  async lose(
    workspaceId: string,
    id: string,
    dto: LoseOpportunityDto,
    user: MarketingUserPayload,
  ) {
    const opp = await this.getScoped(workspaceId, id, user);
    const lostStage = await this.prisma.pipelineStage.findFirst({
      where: { workspaceId, pipelineId: opp.pipelineId, isLost: true },
      orderBy: { position: 'asc' },
    });
    const now = new Date();
    const trace = await this.dealTrace(workspaceId, opp, 'lost', lostStage, user.id, dto.reason);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.opportunity.update({
        where: { id },
        data: {
          status: 'LOST',
          lostAt: now,
          wonAt: null,
          lostReason: dto.reason ?? null,
          ...(lostStage ? { stageId: lostStage.id } : {}),
        },
      });
      if (trace) await tx.leadActivity.create({ data: trace });
      return row;
    });
    // Emit StageChanged when moving into the lost stage too (parity with move() +
    // win()), so a stage-entry workflow trigger fires whether the deal was lost via
    // this button or dragged into the lost stage.
    if (lostStage && opp.stageId !== lostStage.id) {
      void this.emit(
        MarketingEventTypes.OpportunityStageChanged,
        `opp-stage:${id}:${lostStage.id}:${now.getTime()}`,
        {
          workspaceId,
          opportunityId: id,
          leadId: opp.leadId,
          pipelineId: opp.pipelineId,
          fromStageId: opp.stageId,
          toStageId: lostStage.id,
          status: 'LOST',
          occurredAt: now.toISOString(),
        },
      );
    }
    void this.emit(MarketingEventTypes.OpportunityLost, `opp-lost:${id}`, {
      workspaceId,
      opportunityId: id,
      leadId: opp.leadId,
      reason: dto.reason ?? null,
      occurredAt: now.toISOString(),
    });
    return updated;
  }

  async remove(workspaceId: string, id: string, user: MarketingUserPayload) {
    await this.getScoped(workspaceId, id, user);
    await this.prisma.opportunity.delete({ where: { id } });
    return { message: 'Opportunity deleted' };
  }

  /** Best-effort outbox append — never fail a sales op on an outbox hiccup. */
  private async emit(type: string, idempotencyKey: string, payload: Record<string, unknown>) {
    try {
      await this.outbox.append({ type, idempotencyKey, payload });
    } catch (e) {
      this.logger.warn(`outbox append failed (${type}): ${(e as Error).message}`);
    }
  }
}
