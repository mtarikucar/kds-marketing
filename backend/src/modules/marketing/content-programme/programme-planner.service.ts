import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ContentProgramme, ContentSlot, ContentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService } from '../scheduling/scheduled-job-runner.service';
import { Cadence, nextCadenceSlot } from '../social-campaigns/cadence.util';
import { TrendSignalService, TopTrend } from '../trends/trend-signal.service';
import { tokenize } from '../trends/trend-score.util';
import { ContentProgrammeService } from './content-programme.service';
import { ContentTypesService, typeGuidanceLines } from './content-types.service';
import { ProgrammeLearningService } from './programme-learning.service';
import { selectType } from './engine/type-selector.util';

/** The 6-hourly sweep over every live programme (one row, system workspace). */
export const CONTENT_PROGRAMME_PLAN_KIND = 'content.programme.plan';
/** Per slot: plan the concept + storyboard at scheduledFor − planLeadHours. */
export const CONTENT_SLOT_PLAN_KIND = 'content.slot.plan';
/** Per slot: buy the clips at scheduledFor − produceLeadHours. */
export const CONTENT_SLOT_PRODUCE_KIND = 'content.slot.produce';
export const PLAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PROGRAMME_PLAN_DEDUP = 'content-programme-plan';
export const slotPlanDedup = (slotId: string) => `content-slot-plan-${slotId}`;
export const slotProduceDedup = (slotId: string) => `content-slot-produce-${slotId}`;

/** The key the seed gives the format that lives on trends; it always gets a hook. */
export const TREND_REMIX_KEY = 'trend-remix';
/** Any other type gets a trend hook this often — enough to keep the calendar
 *  current, rare enough that the type's own structure still dominates. */
export const TREND_HOOK_PROBABILITY = 0.25;
/** Below this suggestion score a trend is noise for this brand (off-brand AND
 *  fading); the slot is planned on the brief alone. */
export const TREND_MIN_SUGGESTION = 0.2;
/** Three slots failed back to back: something upstream is broken (a dead
 *  provider, an exhausted wallet) and every further slot would just burn. */
export const ANOMALY_FAIL_STREAK = 3;
/** Spend past this multiple of the weekly cap pauses the programme: the per-slot
 *  cap check is a QUOTE, and quotes can run over. */
export const ANOMALY_SPEND_RATIO = 1.2;
/** Slot statuses whose quoted credits count as this week's spend: everything
 *  from "a concept was bought" onwards. PLANNED has no quote yet; SKIPPED and
 *  FAILED were refunded or never charged. */
export const SPENT_SLOT_STATUSES = ['IDEATED', 'PRODUCING', 'READY', 'PUBLISHED', 'MEASURED'];
/** Slots that are still on the calendar (count toward the type window). */
const WINDOW_SLOT_STATUSES = ['PLANNED', 'IDEATED', 'PRODUCING', 'READY', 'PUBLISHED', 'MEASURED'];
const PROGRAMME_TIMEZONE = 'Europe/Istanbul';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const hours = (h: number) => h * HOUR_MS;

export interface FillResult {
  created: number;
}

/**
 * Monday 00:00 → next Monday 00:00 in Europe/Istanbul, the week the credit
 * cap is counted over. Computed through Intl so the zone's rules (fixed +03
 * today, but that is the zone's business, not ours) never leak into the code.
 * Exported for the producer's `weekSpend`, which shares the definition.
 */
export function istanbulWeekBounds(now: Date): { weekStart: Date; weekEnd: Date } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PROGRAMME_TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const daysSinceMonday = (dow + 6) % 7;
  const y = Number(parts.year);
  const m = Number(parts.month) - 1;
  const d = Number(parts.day);
  // The zone offset at `now`, from the local wall clock read back against UTC,
  // rounded to the minute so sub-second formatting noise cannot shift it.
  const localAsUtc = Date.UTC(y, m, d, Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  const offsetMs = Math.round((localAsUtc - now.getTime()) / 60_000) * 60_000;
  const localMidnightAsUtc = Date.UTC(y, m, d);
  const weekStart = new Date(localMidnightAsUtc - daysSinceMonday * DAY_MS - offsetMs);
  return { weekStart, weekEnd: new Date(weekStart.getTime() + 7 * DAY_MS) };
}

/**
 * Σ quotedCredits of the programme's slots inside this Istanbul week that are
 * past the point of having bought something. One implementation for the
 * planner's anomaly check and the producer's cap check, so the two cannot
 * disagree about what "this week's spend" is.
 */
export async function sumWeekSpend(
  prisma: PrismaService,
  workspaceId: string,
  programmeId: string,
  now: Date,
  opts: { excludeSlotId?: string } = {},
): Promise<{ weekStart: Date; weekEnd: Date; spent: number }> {
  const { weekStart, weekEnd } = istanbulWeekBounds(now);
  const rows: Array<{ id: string; quotedCredits: number | null }> = await prisma.contentSlot.findMany({
    where: {
      workspaceId,
      programmeId,
      status: { in: SPENT_SLOT_STATUSES },
      scheduledFor: { gte: weekStart, lt: weekEnd },
      ...(opts.excludeSlotId ? { id: { not: opts.excludeSlotId } } : {}),
    },
    select: { id: true, quotedCredits: true },
  });
  const spent = rows.reduce((s, r) => s + (r.quotedCredits ?? 0), 0);
  return { weekStart, weekEnd, spent };
}

/** The two per-slot jobs, at the slot's lead times. A slot already inside its
 *  lead window (planned late, or moved close) is planned NOW rather than never:
 *  the runner only claims rows whose runAt has passed, so a runAt in the past
 *  is simply "next tick". Shared with the editor, which re-arms on a move. */
export async function scheduleSlotJobs(
  scheduledJobs: ScheduledJobService,
  workspaceId: string,
  programme: Pick<ContentProgramme, 'id' | 'planLeadHours' | 'produceLeadHours'>,
  slot: Pick<ContentSlot, 'id' | 'scheduledFor'>,
  now: Date,
): Promise<void> {
  const clamp = (t: number) => new Date(Math.max(t, now.getTime()));
  const payload = { workspaceId, slotId: slot.id, programmeId: programme.id };
  await scheduledJobs.schedule({
    workspaceId,
    kind: CONTENT_SLOT_PLAN_KIND,
    runAt: clamp(slot.scheduledFor.getTime() - hours(programme.planLeadHours)),
    payload,
    dedupKey: slotPlanDedup(slot.id),
  });
  await scheduledJobs.schedule({
    workspaceId,
    kind: CONTENT_SLOT_PRODUCE_KIND,
    runAt: clamp(slot.scheduledFor.getTime() - hours(programme.produceLeadHours)),
    payload,
    dedupKey: slotProduceDedup(slot.id),
  });
}

export async function cancelSlotJobs(scheduledJobs: ScheduledJobService, slotId: string): Promise<void> {
  await scheduledJobs.cancel(CONTENT_SLOT_PLAN_KIND, slotPlanDedup(slotId));
  await scheduledJobs.cancel(CONTENT_SLOT_PRODUCE_KIND, slotProduceDedup(slotId));
}

/** The line a trend adds to the idea. "Adapt, don't copy" is the whole brief
 *  for a remix: the model is told what is hot, not to reproduce it. */
export function trendLine(t: { title: string; network: string; kind: string }): string {
  return `Trend kancası: ${t.title} (${t.network}/${t.kind}) — kopyalama, markaya uyarla`;
}

/** The idea text a slot hands the concept planner. Deterministic — no model
 *  call — so the owner can read exactly what will be asked, and edit it. */
export function composeIdea(
  type: Pick<ContentType, 'name' | 'description' | 'structure' | 'defaultDurationSec'>,
  brief: string,
  trend: { title: string; network: string; kind: string } | null,
): string {
  const desc = (type.description ?? '').trim();
  const lines = [desc ? `${type.name}: ${desc}` : type.name, ...typeGuidanceLines(type), `Program brief'i: ${brief.trim()}`];
  if (trend) lines.push(trendLine(trend));
  return lines.join('\n');
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/**
 * THE PLANNER — the half of the loop that runs BEFORE anything is made. Every
 * six hours, for every live programme:
 *
 *   reconcile  PRODUCING slots follow their campaign item (READY / FAILED / SKIPPED)
 *   fill       open a PLANNED slot at every cadence time inside `lookaheadDays`
 *              that has none: the type selector picks the format (and says
 *              why), a trend hook is attached when the format wants one, the
 *              idea text is composed, and the two per-slot jobs are armed at
 *              the slot's lead times
 *   anomaly    three failures in a row, or spend past 120% of the cap, pause
 *              the programme with the reason in the log
 *
 * Every read and write is workspace-scoped even though the sweep walks every
 * workspace's programme: the programme row carries its workspaceId and every
 * query repeats it. `rng` is a public property so a test can replay the exact
 * selector draw; production uses Math.random.
 */
@Injectable()
export class ProgrammePlannerService implements OnModuleInit {
  private readonly logger = new Logger(ProgrammePlannerService.name);
  /** Injected randomness: the selector's coin and the trend-hook coin. */
  rng: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly programmes: ContentProgrammeService,
    private readonly types: ContentTypesService,
    private readonly learning: ProgrammeLearningService,
    private readonly trends: TrendSignalService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CONTENT_PROGRAMME_PLAN_KIND, async () => {
      await this.runAll();
      return { reschedule: { runAt: new Date(Date.now() + PLAN_INTERVAL_MS) } };
    });
    void this.scheduledJobs
      .schedule({
        workspaceId: 'system',
        kind: CONTENT_PROGRAMME_PLAN_KIND,
        runAt: new Date(Date.now() + PLAN_INTERVAL_MS),
        payload: {},
        dedupKey: PROGRAMME_PLAN_DEDUP,
      })
      .catch(() => undefined);
  }

  /** One tick over every live programme; one programme's failure is its own
   *  PLAN_ERROR event, never another programme's lost tick. */
  async runAll(now = new Date()): Promise<void> {
    const programmes = await this.prisma.contentProgramme.findMany({ where: { status: 'ACTIVE', killSwitch: false } });
    for (const p of programmes) {
      try {
        await this.reconcile(p.workspaceId, p);
        await this.fill(p.workspaceId, p, now);
        await this.checkAnomalies(p.workspaceId, p, now);
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 500);
        this.logger.warn(`plan tick failed for programme ${p.id}: ${msg}`);
        await this.programmes.logEvent(p.workspaceId, p.id, 'PLAN_ERROR', `Planning tick failed: ${msg}`, { error: msg });
      }
    }
  }

  /**
   * Open the slots the look-ahead window is missing. The walk starts at the
   * later of now and the last planned slot — a cadence change reaches the
   * calendar after the slots already on it, never underneath them — and stops
   * at now + lookaheadDays. (programmeId, scheduledFor) is unique, so a time a
   * concurrent tick already filled is a caught P2002 and a skipped iteration.
   */
  async fill(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<FillResult> {
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: programme.socialCampaignId, workspaceId },
      select: { cadence: true, targetAccountIds: true },
    });
    if (!campaign) throw new Error(`programme ${programme.id}: its campaign ${programme.socialCampaignId} is gone`);
    const cadence = (campaign.cadence ?? {}) as unknown as Cadence;
    const horizon = new Date(now.getTime() + programme.lookaheadDays * DAY_MS);

    const typeRows = await this.types.list(workspaceId, { activeOnly: true });
    const typeByKey = new Map(typeRows.map((t) => [t.key, t]));
    if (typeByKey.size === 0) throw new Error('no active content type to plan with');

    const targetNetworks = await this.targetNetworks(workspaceId, campaign.targetAccountIds);
    const armsAll = await this.learning.currentArms(workspaceId, programme.id);
    // A format declared for networks the programme does not publish to would
    // plan a slot no account can carry. Empty `networks` means "any".
    const arms = armsAll.filter((a) => {
      const t = typeByKey.get(a.key);
      return t && (t.networks.length === 0 || targetNetworks.length === 0 || t.networks.some((n) => targetNetworks.includes(n)));
    });
    const usable = arms.length > 0 ? arms : armsAll;

    const upcoming = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, scheduledFor: { gte: now }, status: { in: WINDOW_SLOT_STATUSES } },
      orderBy: { scheduledFor: 'asc' },
      select: { id: true, scheduledFor: true, contentTypeKey: true },
    });
    const last = await this.prisma.contentSlot.findFirst({
      where: { workspaceId, programmeId: programme.id },
      orderBy: { scheduledFor: 'desc' },
      select: { scheduledFor: true, contentTypeKey: true },
    });
    let seedCursor = await this.prisma.contentSlot.count({ where: { workspaceId, programmeId: programme.id } });

    const windowCounts: Record<string, number> = {};
    for (const s of upcoming) windowCounts[s.contentTypeKey] = (windowCounts[s.contentTypeKey] ?? 0) + 1;
    let windowSize = upcoming.length;
    const taken = new Set(upcoming.map((s) => s.scheduledFor.getTime()));
    let previousKey: string | null = last?.contentTypeKey ?? null;

    let brandKeywords: string[] | null = null;
    let topTrends: TopTrend[] | null = null;
    const pickTrend = async (): Promise<TopTrend | null> => {
      if (topTrends === null) {
        brandKeywords = brandKeywords ?? (await this.brandKeywords(workspaceId, programme));
        topTrends = await this.trends.top('TR', { networks: targetNetworks, brandKeywords, limit: 5, now });
      }
      const best = topTrends[0];
      return best && best.suggestion > TREND_MIN_SUGGESTION ? best : null;
    };

    let cursor = new Date(Math.max(now.getTime(), last?.scheduledFor.getTime() ?? 0));
    let created = 0;
    const mix: Record<string, number> = {};
    for (let guard = 0; guard < 400; guard++) {
      const at = nextCadenceSlot(cadence, cursor);
      if (!at || at > horizon) break;
      cursor = at;
      if (taken.has(at.getTime())) continue;

      const choice = selectType({
        arms: usable,
        phase: programme.phase as 'SEED' | 'LEARN' | 'EXPLOIT',
        explorationRate: programme.explorationRate,
        windowCounts,
        windowSize: windowSize + 1,
        previousKey,
        seedCursor,
        rng: this.rng,
      });
      const type = typeByKey.get(choice.key);
      if (!type) throw new Error(`selector chose an unknown type ${choice.key}`);

      // The remix format always hooks a trend; any other format gets one
      // sometimes. The coin is drawn AFTER the selector so a replayed rng
      // reproduces the same type before it reproduces the same hook.
      const wantsTrend = choice.key === TREND_REMIX_KEY || this.rng() < TREND_HOOK_PROBABILITY;
      const trend = wantsTrend ? await pickTrend() : null;
      const trendRef = trend ? { title: trend.signal.title, network: trend.signal.network, kind: trend.signal.kind } : null;

      const data: Prisma.ContentSlotUncheckedCreateInput = {
        workspaceId,
        programmeId: programme.id,
        scheduledFor: at,
        status: 'PLANNED',
        contentTypeId: type.id,
        contentTypeKey: type.key,
        selectionReason: choice.reason,
        trendSignalId: trend?.signal.id ?? null,
        trendTitle: trend?.signal.title ?? null,
        idea: composeIdea(type, programme.brief, trendRef),
        editableUntil: new Date(at.getTime() - hours(programme.editWindowHours)),
      };
      let slot: ContentSlot;
      try {
        slot = await this.prisma.contentSlot.create({ data });
      } catch (e) {
        if (isUniqueViolation(e)) {
          taken.add(at.getTime());
          continue;
        }
        throw e;
      }
      await scheduleSlotJobs(this.scheduledJobs, workspaceId, programme, slot, now);

      taken.add(at.getTime());
      windowCounts[type.key] = (windowCounts[type.key] ?? 0) + 1;
      windowSize++;
      previousKey = type.key;
      seedCursor++;
      created++;
      mix[type.key] = (mix[type.key] ?? 0) + 1;
    }

    if (created > 0) {
      const mixLine = Object.entries(mix).map(([k, n]) => `${k} ×${n}`).join(', ');
      await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_PLANNED', `Planned ${created} slot(s): ${mixLine}.`, {
        created, mix, phase: programme.phase, until: horizon.toISOString(),
      });
    }
    await this.prisma.contentProgramme.updateMany({ where: { id: programme.id, workspaceId }, data: { lastPlannedAt: now } });
    return { created };
  }

  /** The words a trend is matched against: the brand's name, tagline and
   *  description plus the programme's brief, folded and de-duplicated. */
  async brandKeywords(workspaceId: string, programme: Pick<ContentProgramme, 'brief'>): Promise<string[]> {
    const brand = await this.prisma.brandProfile.findFirst({
      where: { workspaceId },
      select: { brandName: true, tagline: true, description: true },
    });
    const words = new Set<string>();
    if (brand) for (const w of tokenize([brand.brandName, brand.tagline ?? '', brand.description ?? ''].join(' '))) words.add(w);
    for (const w of tokenize(programme.brief)) words.add(w);
    return [...words];
  }

  /**
   * PRODUCING slots follow their item. SCHEDULED / NEEDS_APPROVAL / PUBLISHED
   * all mean the clips exist and the gate is armed → READY (the learning
   * service's `settle` takes READY → PUBLISHED, so a PUBLISHED item is READY
   * here and PUBLISHED one tick later — the slot walks the same path either
   * way). FAILED and SKIPPED carry the item's verdict onto the slot.
   */
  async reconcile(workspaceId: string, programme: ContentProgramme): Promise<void> {
    const slots = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, status: 'PRODUCING', campaignItemId: { not: null } },
    });
    if (slots.length === 0) return;
    const items: Array<{ id: string; status: string; error: string | null; socialPostId: string | null }> =
      await this.prisma.socialCampaignItem.findMany({
        where: { id: { in: slots.map((s) => s.campaignItemId as string) }, workspaceId },
        select: { id: true, status: true, error: true, socialPostId: true },
      });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const slot of slots) {
      const item = byId.get(slot.campaignItemId as string);
      if (!item) continue;
      const where = { id: slot.id, workspaceId, status: 'PRODUCING' };
      if (item.status === 'SCHEDULED' || item.status === 'NEEDS_APPROVAL' || item.status === 'PUBLISHED') {
        await this.prisma.contentSlot.updateMany({
          where,
          data: { status: 'READY', error: null, ...(item.socialPostId ? { socialPostId: item.socialPostId } : {}) },
        });
        await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_READY', `Slot ${slot.contentTypeKey} is ready: clips made, publish gate armed.`, {
          slotId: slot.id, contentTypeKey: slot.contentTypeKey, campaignItemId: item.id, itemStatus: item.status,
        });
      } else if (item.status === 'FAILED') {
        const error = (item.error ?? 'production failed').slice(0, 500);
        await this.prisma.contentSlot.updateMany({ where, data: { status: 'FAILED', error } });
        await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_FAILED', `Slot ${slot.contentTypeKey} failed in production: ${error}`, {
          slotId: slot.id, contentTypeKey: slot.contentTypeKey, campaignItemId: item.id, error,
        });
      } else if (item.status === 'SKIPPED') {
        await this.prisma.contentSlot.updateMany({ where, data: { status: 'SKIPPED', error: 'campaign item skipped' } });
        await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_SKIPPED', `Slot ${slot.contentTypeKey} skipped: its campaign item was rejected.`, {
          slotId: slot.id, contentTypeKey: slot.contentTypeKey, campaignItemId: item.id,
        });
      }
    }
  }

  /**
   * The two circuit breakers. A failure streak is checked against the last
   * ANOMALY_PAUSE so a resume does not trip again on the same three slots; a
   * spend overrun always trips (the money is the money).
   */
  async checkAnomalies(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<void> {
    const recent: Array<{ id: string; status: string; error: string | null }> = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, status: { not: 'PLANNED' } },
      orderBy: { scheduledFor: 'desc' },
      take: ANOMALY_FAIL_STREAK,
      select: { id: true, status: true, error: true },
    });
    if (recent.length === ANOMALY_FAIL_STREAK && recent.every((s) => s.status === 'FAILED')) {
      const ids = recent.map((s) => s.id).sort();
      const previous = await this.prisma.contentProgrammeEvent.findFirst({
        where: { workspaceId, programmeId: programme.id, kind: 'ANOMALY_PAUSE' },
        orderBy: { createdAt: 'desc' },
        select: { data: true },
      });
      const seen = (previous?.data as { slotIds?: string[] } | null)?.slotIds;
      if (!(Array.isArray(seen) && seen.length === ids.length && seen.every((id, i) => id === ids[i]))) {
        const reasons = recent.map((s) => s.error ?? 'unknown').join('; ').slice(0, 400);
        await this.programmes.pause(workspaceId, programme.id);
        await this.programmes.logEvent(workspaceId, programme.id, 'ANOMALY_PAUSE',
          `${ANOMALY_FAIL_STREAK} slots failed in a row: ${reasons}. Programme paused; fix the cause and resume.`,
          { reason: 'fail-streak', slotIds: ids, errors: recent.map((s) => s.error) });
        return;
      }
    }

    const { spent, weekStart } = await sumWeekSpend(this.prisma, workspaceId, programme.id, now);
    const limit = ANOMALY_SPEND_RATIO * programme.weeklyCreditCap;
    if (spent > limit) {
      await this.programmes.pause(workspaceId, programme.id);
      await this.programmes.logEvent(workspaceId, programme.id, 'ANOMALY_PAUSE',
        `This week's spend (${spent} credits) is past ${Math.round(ANOMALY_SPEND_RATIO * 100)}% of the ${programme.weeklyCreditCap}-credit cap. Programme paused.`,
        { reason: 'spend', spent, cap: programme.weeklyCreditCap, limit, weekStart: weekStart.toISOString() });
    }
  }

  private async targetNetworks(workspaceId: string, accountIds: string[]): Promise<string[]> {
    if (!accountIds?.length) return [];
    const accounts: Array<{ network: string }> = await this.prisma.socialAccount.findMany({
      where: { id: { in: accountIds }, workspaceId },
      select: { network: true },
    });
    return [...new Set(accounts.map((a) => a.network))];
  }
}
