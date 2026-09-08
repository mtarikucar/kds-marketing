import { Injectable, NotFoundException } from '@nestjs/common';
import type { ContentProgramme, ContentProgrammeEvent, ContentSlot, ContentType, ContentTypeStat } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TrendSignalService } from '../trends/trend-signal.service';
import { ContentProgrammeService } from './content-programme.service';
import { ContentTypesService } from './content-types.service';
import { ProgrammePlannerService } from './programme-planner.service';
import { EDITABLE_SLOT_STATUSES } from './slot-editor.service';
import { SlotProducerService } from './slot-producer.service';

/** The programme-wide blend row the learning job writes beside each network. */
const ALL = 'ALL';
const DAY_MS = 24 * 60 * 60 * 1000;
/** The dashboard's slot window opens one day back so yesterday's publish is still on the strip. */
const SLOT_WINDOW_BACK_MS = DAY_MS;
/** How many reweight points the weights chart shows. */
const HISTORY_POINTS = 12;
/** Upper bound on types per reweight point, for the history read's `take`. */
const MAX_TYPES_PER_POINT = 50;
const DASHBOARD_EVENTS = 30;
const TREND_LIMIT = 10;
/** Mirrors the region the refresh job fills (trend-signal.service.ts); v1 serves Turkish workspaces. */
const TREND_REGION = process.env.TREND_REGION ?? 'TR';

/** The editor's own rule, so `editable` on the strip never disagrees with what
 *  `SlotEditorService.updateSlot` would then refuse. */
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(EDITABLE_SLOT_STATUSES);

export interface SlotView {
  id: string;
  scheduledFor: string;
  status: string;
  contentTypeKey: string;
  contentTypeName: string;
  selectionReason: string;
  trendTitle: string | null;
  idea: string;
  conceptId: string | null;
  campaignItemId: string | null;
  socialPostId: string | null;
  quotedCredits: number | null;
  editableUntil: string;
  editable: boolean;
  publishedAt: string | null;
  reward: number | null;
  error: string | null;
  concept: { title: string; hook: string; angle: string } | null;
}

export interface TypeView {
  id: string;
  key: string;
  name: string;
  description: string;
  active: boolean;
  minShare: number;
  maxShare: number;
  defaultDurationSec: number;
  networks: string[];
  /** The latest programme-wide (ALL) weight, 0 before the first reweight. */
  weight: number;
  samples: number;
  meanReward: number | null;
  /** This type's share of the upcoming, non-skipped slots. */
  plannedShare: number;
}

export interface LearningRow {
  typeKey: string;
  network: string;
  samples: number;
  alpha: number;
  beta: number;
  meanReward: number;
  weight: number;
  computedAt: string;
}

export interface LearningView {
  phase: string;
  lastReweightedAt: string | null;
  /** 'ALL' first, then every network a stat row exists for. */
  networks: string[];
  rows: LearningRow[];
  /** The last 12 ALL reweights, oldest first: one weights map per point. */
  history: Array<{ computedAt: string; weights: Record<string, number> }>;
}

export interface TrendView {
  id: string;
  network: string;
  kind: string;
  title: string;
  ref: string | null;
  decayed: number;
  relevance: number;
  suggestion: number;
  observedAt: string;
}

export interface EventView {
  id: string;
  kind: string;
  message: string;
  data: unknown;
  createdAt: string;
}

export interface Dashboard {
  phase: string;
  status: string;
  killSwitch: boolean;
  week: { weekStart: string; spent: number; cap: number };
  slots: SlotView[];
  types: TypeView[];
  learning: LearningView;
  trends: TrendView[];
  events: EventView[];
}

type ConceptSummary = { title: string; hook: string; angle: string };

/**
 * THE READ MODEL of the programme panel — every number the Studio's single
 * screen shows, projected from rows the jobs wrote. It writes nothing.
 *
 * Why a service of its own rather than views computed in the controller and
 * the MCP tool: the panel, `GET /marketing/content-programme` and
 * `jeeta.get_content_programme` must show the SAME dashboard, and the slot
 * returned after an edit must be the SAME shape as the slot on the strip.
 * One projection, three callers.
 *
 * Every read repeats `workspaceId`: slot, stat, concept and event rows are
 * reached by plain id columns, not foreign keys, so nothing in the schema
 * refuses a cross-tenant join — the predicate is the only wall.
 */
@Injectable()
export class ProgrammeDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programmes: ContentProgrammeService,
    private readonly types: ContentTypesService,
    private readonly trends: TrendSignalService,
    private readonly producer: SlotProducerService,
    private readonly planner: ProgrammePlannerService,
  ) {}

  async dashboard(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<Dashboard> {
    const from = new Date(now.getTime() - SLOT_WINDOW_BACK_MS);
    const to = new Date(now.getTime() + programme.lookaheadDays * DAY_MS);
    const [week, slots, types, learning, trends, events] = await Promise.all([
      this.producer.weekSpend(workspaceId, programme.id, now),
      this.slots(workspaceId, programme.id, from, to, now),
      this.typeViews(workspaceId, programme.id, now),
      this.learning(workspaceId, programme),
      this.trendViews(workspaceId, programme, now),
      this.events(workspaceId, programme.id, DASHBOARD_EVENTS),
    ]);
    return {
      phase: programme.phase,
      status: programme.status,
      killSwitch: programme.killSwitch,
      week: { weekStart: week.weekStart.toISOString(), spent: week.spent, cap: programme.weeklyCreditCap },
      slots,
      types,
      learning,
      trends,
      events,
    };
  }

  /** The programme's slots in [from, to], calendar order, with their concept summaries. */
  async slots(workspaceId: string, programmeId: string, from: Date, to: Date, now = new Date()): Promise<SlotView[]> {
    const rows = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId, scheduledFor: { gte: from, lte: to } },
      orderBy: { scheduledFor: 'asc' },
    });
    return this.views(workspaceId, rows, now);
  }

  /**
   * One slot as the panel sees it. The programme id is checked against the row
   * so a route under `/:id/slots/:slotId` cannot read (or, through the editor,
   * write) a slot of another programme by guessing its id.
   */
  async slotView(workspaceId: string, programmeId: string, slotId: string, now = new Date()): Promise<SlotView> {
    const row = await this.prisma.contentSlot.findFirst({ where: { id: slotId, workspaceId } });
    if (!row || row.programmeId !== programmeId) throw new NotFoundException('Slot not found');
    const [view] = await this.views(workspaceId, [row], now);
    return view;
  }

  /** Every type (retired ones included, so the panel can re-enable them), joined to what it has learned and what it is about to do. */
  async typeViews(workspaceId: string, programmeId: string, now = new Date()): Promise<TypeView[]> {
    const [types, stats, upcoming] = await Promise.all([
      this.types.list(workspaceId),
      this.prisma.contentTypeStat.findMany({
        where: { workspaceId, programmeId, network: ALL },
        orderBy: [{ contentTypeKey: 'asc' }, { computedAt: 'desc' }],
        distinct: ['contentTypeKey'],
      }),
      this.prisma.contentSlot.findMany({
        where: { workspaceId, programmeId, scheduledFor: { gte: now }, status: { not: 'SKIPPED' } },
        select: { contentTypeKey: true },
      }),
    ]);
    const statByKey = new Map<string, ContentTypeStat>();
    for (const s of stats) if (!statByKey.has(s.contentTypeKey)) statByKey.set(s.contentTypeKey, s);
    const planned = new Map<string, number>();
    for (const s of upcoming) planned.set(s.contentTypeKey, (planned.get(s.contentTypeKey) ?? 0) + 1);
    const total = upcoming.length;
    return types.map((t) => this.toTypeView(t, statByKey.get(t.key), total > 0 ? (planned.get(t.key) ?? 0) / total : 0));
  }

  /** The type×network posterior table and the weights-over-time series. */
  async learning(workspaceId: string, programme: ContentProgramme): Promise<LearningView> {
    const [latest, history] = await Promise.all([
      this.prisma.contentTypeStat.findMany({
        where: { workspaceId, programmeId: programme.id },
        orderBy: [{ contentTypeKey: 'asc' }, { network: 'asc' }, { computedAt: 'desc' }],
        distinct: ['contentTypeKey', 'network'],
      }),
      this.prisma.contentTypeStat.findMany({
        where: { workspaceId, programmeId: programme.id, network: ALL },
        orderBy: { computedAt: 'desc' },
        take: HISTORY_POINTS * MAX_TYPES_PER_POINT,
      }),
    ]);

    const networks = new Set<string>();
    for (const r of latest) if (r.network !== ALL) networks.add(r.network);
    const rows: LearningRow[] = latest
      .map((r) => ({
        typeKey: r.contentTypeKey, network: r.network, samples: r.samples, alpha: r.alpha, beta: r.beta,
        meanReward: r.meanReward, weight: r.weight, computedAt: r.computedAt.toISOString(),
      }))
      // ALL first within each type, then the networks alphabetically — the
      // order the panel's table reads in.
      .sort((a, b) => a.typeKey.localeCompare(b.typeKey) || rank(a.network) - rank(b.network) || a.network.localeCompare(b.network));

    // Newest first from the DB; group by reweight instant, keep the newest 12
    // groups, then flip to oldest-first so a chart draws left to right.
    const points = new Map<string, Record<string, number>>();
    for (const r of history) {
      const at = r.computedAt.toISOString();
      let weights = points.get(at);
      if (!weights) {
        if (points.size >= HISTORY_POINTS) continue;
        weights = {};
        points.set(at, weights);
      }
      weights[r.contentTypeKey] = r.weight;
    }
    const series = [...points.entries()].map(([computedAt, weights]) => ({ computedAt, weights })).reverse();

    return {
      phase: programme.phase,
      lastReweightedAt: programme.lastReweightedAt ? programme.lastReweightedAt.toISOString() : null,
      networks: [ALL, ...[...networks].sort()],
      rows,
      history: series,
    };
  }

  /** The region's freshest signals, ranked by how on-brand they are for THIS programme. */
  async trendViews(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<TrendView[]> {
    const brandKeywords = await this.planner.brandKeywords(workspaceId, programme);
    const top = await this.trends.top(TREND_REGION, { brandKeywords, limit: TREND_LIMIT, now });
    return top.map((t) => ({
      id: t.signal.id,
      network: t.signal.network,
      kind: t.signal.kind,
      title: t.signal.title,
      ref: t.signal.ref ?? null,
      decayed: t.decayed,
      relevance: t.relevance,
      suggestion: t.suggestion,
      observedAt: t.signal.observedAt.toISOString(),
    }));
  }

  async events(workspaceId: string, programmeId: string, limit: number): Promise<EventView[]> {
    const rows = await this.programmes.events(workspaceId, programmeId, limit);
    return rows.map((e: ContentProgrammeEvent) => ({
      id: e.id, kind: e.kind, message: e.message, data: e.data ?? null, createdAt: e.createdAt.toISOString(),
    }));
  }

  /**
   * The projection itself. `editable` is the one derived field: the window is
   * still open AND the slot is in a state where a rewrite changes what will be
   * made — a PRODUCING slot has clips in flight and a PUBLISHED one is out.
   */
  toSlotView(slot: ContentSlot, typeNameByKey: Map<string, string>, conceptById: Map<string, ConceptSummary>, now: Date): SlotView {
    return {
      id: slot.id,
      scheduledFor: slot.scheduledFor.toISOString(),
      status: slot.status,
      contentTypeKey: slot.contentTypeKey,
      contentTypeName: typeNameByKey.get(slot.contentTypeKey) ?? slot.contentTypeKey,
      selectionReason: slot.selectionReason,
      trendTitle: slot.trendTitle ?? null,
      idea: slot.idea,
      conceptId: slot.conceptId ?? null,
      campaignItemId: slot.campaignItemId ?? null,
      socialPostId: slot.socialPostId ?? null,
      quotedCredits: slot.quotedCredits ?? null,
      editableUntil: slot.editableUntil.toISOString(),
      editable: now < slot.editableUntil && EDITABLE_STATUSES.has(slot.status),
      publishedAt: slot.publishedAt ? slot.publishedAt.toISOString() : null,
      reward: slot.reward ?? null,
      error: slot.error ?? null,
      concept: (slot.conceptId && conceptById.get(slot.conceptId)) || null,
    };
  }

  // ───────────────────────────────────────────────────────── internals

  /** Names and concept summaries for a batch of slots, each in ONE query. */
  private async views(workspaceId: string, rows: ContentSlot[], now: Date): Promise<SlotView[]> {
    if (rows.length === 0) return [];
    const conceptIds = [...new Set(rows.map((r) => r.conceptId).filter((id): id is string => Boolean(id)))];
    const [types, concepts] = await Promise.all([
      this.types.list(workspaceId),
      conceptIds.length
        ? this.prisma.contentConcept.findMany({
            where: { id: { in: conceptIds }, workspaceId },
            select: { id: true, title: true, hook: true, angle: true },
          })
        : Promise.resolve([] as Array<{ id: string; title: string; hook: string; angle: string }>),
    ]);
    const typeNameByKey = new Map(types.map((t) => [t.key, t.name]));
    const conceptById = new Map(concepts.map((c) => [c.id, { title: c.title, hook: c.hook, angle: c.angle }]));
    return rows.map((r) => this.toSlotView(r, typeNameByKey, conceptById, now));
  }

  private toTypeView(t: ContentType, stat: ContentTypeStat | undefined, plannedShare: number): TypeView {
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      active: t.active,
      minShare: t.minShare,
      maxShare: t.maxShare,
      defaultDurationSec: t.defaultDurationSec,
      networks: [...t.networks],
      weight: stat?.weight ?? 0,
      samples: stat?.samples ?? 0,
      meanReward: stat ? stat.meanReward : null,
      plannedShare,
    };
  }
}

const rank = (network: string) => (network === ALL ? 0 : 1);
