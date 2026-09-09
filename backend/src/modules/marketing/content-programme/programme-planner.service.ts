import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ContentProgramme, ContentSlot, ContentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService } from '../scheduling/scheduled-job-runner.service';
import { Cadence, nextCadenceSlot } from '../social-campaigns/cadence.util';
import { TrendSignalService, TopTrend, TREND_REGION } from '../trends/trend-signal.service';
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
 *  fading); the slot is planned on the brief alone. Suggestion scores are on
 *  the providers' 0..100 scale (a fresh, on-brand signal sits around 30-100;
 *  a fading off-brand one decays through the single digits), so the gate is
 *  a score on that scale — 15 is roughly "half-faded and half-relevant". */
export const TREND_MIN_SUGGESTION = 15;
/** How many trends one fill rotates through, so a fortnight of slots does not
 *  all riff on the single hottest signal. */
export const TREND_ROTATION = 5;
/** The region the planner reads trends for. It mirrors the region the refresh
 *  job fills (`trend-signal.service.ts` keeps its own copy un-exported) and the
 *  dashboard reads: one env var, three readers, so a workspace never plans on
 *  a region the feed does not fill. */
/** Three slots failed back to back: something upstream is broken (a dead
 *  provider, an exhausted wallet) and every further slot would just burn. */
export const ANOMALY_FAIL_STREAK = 3;
/** Spend past this multiple of the weekly cap pauses the programme: the per-slot
 *  cap check is a QUOTE, and quotes can run over. */
export const ANOMALY_SPEND_RATIO = 1.2;
/** Slot statuses that are over: the fail-streak breaker reads the last few of
 *  these. PLANNED/IDEATED/PRODUCING/READY are still in flight and say nothing
 *  about whether the pipeline works. */
export const TERMINAL_SLOT_STATUSES = ['FAILED', 'SKIPPED', 'PUBLISHED', 'MEASURED'];
/** The error prefix the editor writes on a slot the OWNER skipped; such a skip
 *  is a decision, not a symptom, and is left out of the streak. */
export const OWNER_SKIP_PREFIX = 'skipped by';
/** How many terminal slots the streak check reads before dropping owner skips. */
const STREAK_SCAN = 10;
/** A PRODUCING slot with no item this long after its claim was orphaned by a
 *  crash between the claim and the link write (the reaper's own revive delay,
 *  so a job that is merely slow is never mistaken for a dead one). */
export const ORPHAN_PRODUCING_MS = 15 * 60 * 1000;
/** The error the orphan sweep writes on a slot whose concept never became an item. */
export const PRODUCTION_DID_NOT_START = 'production did not start';
/** Programme statuses the reconcile sweep still visits: a paused or killed
 *  programme's in-flight slots still follow their items (an item the kill
 *  could not reject publishes; a produced slot must still reach READY). */
const RECONCILED_PROGRAMME_STATUSES = ['ACTIVE', 'PAUSED', 'KILLED'];
/** Slots that are still on the calendar (count toward the type window). */
const WINDOW_SLOT_STATUSES = ['PLANNED', 'IDEATED', 'PRODUCING', 'READY', 'PUBLISHED', 'MEASURED'];
/** The first sweep after boot waits this long — enough for the app to settle,
 *  short enough that a deploy cadence faster than the sweep interval can never
 *  starve it (a dedup'd PENDING row has its runAt rewritten on every boot). */
export const BOOT_SWEEP_DELAY_MS = 60 * 1000;
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
 * Σ spentCredits of EVERY slot of the programme inside this Istanbul week,
 * whatever its status: a SKIPPED slot's frames and a FAILED slot's half-bought
 * clips were paid for, and a regenerate is a second purchase on the same row.
 * One implementation for the planner's anomaly check, the producer's cap
 * checks, the editor's regenerate and the dashboard, so none of them can
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
  const rows: Array<{ id: string; spentCredits: number | null }> = await prisma.contentSlot.findMany({
    where: {
      workspaceId,
      programmeId,
      scheduledFor: { gte: weekStart, lt: weekEnd },
      ...(opts.excludeSlotId ? { id: { not: opts.excludeSlotId } } : {}),
    },
    select: { id: true, spentCredits: true },
  });
  const spent = rows.reduce((s, r) => s + (r.spentCredits ?? 0), 0);
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
 * six hours, for every programme that is not archived:
 *
 *   reconcile  PRODUCING slots follow their campaign item (READY / FAILED /
 *              SKIPPED); orphans (claimed, never linked) are linked or failed.
 *              Runs for ACTIVE, PAUSED and KILLED programmes alike — a slot
 *              in flight when the programme stopped still ends somewhere.
 *   fill       (ACTIVE only) open a PLANNED slot at every cadence time inside `lookaheadDays`
 *              that has none: the type selector picks the format (and says
 *              why), a trend hook is attached when the format wants one, the
 *              idea text is composed, and the two per-slot jobs are armed at
 *              the slot's lead times
 *   anomaly    three settled slots failed in a row, or real spend past 120%
 *              of the cap, pause the programme with the reason in the log
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
        runAt: new Date(Date.now() + BOOT_SWEEP_DELAY_MS),
        payload: {},
        dedupKey: PROGRAMME_PLAN_DEDUP,
      })
      .catch(() => undefined);
  }

  /** One tick over every programme that is not archived; one programme's
   *  failure is its own PLAN_ERROR event, never another programme's lost tick.
   *  Only a running programme is filled and breaker-checked; every one is
   *  reconciled, so a kill or a pause never leaves a slot PRODUCING for good. */
  async runAll(now = new Date()): Promise<void> {
    const programmes = await this.prisma.contentProgramme.findMany({ where: { status: { in: RECONCILED_PROGRAMME_STATUSES } } });
    for (const p of programmes) {
      try {
        await this.reconcile(p.workspaceId, p, now);
        if (p.status !== 'ACTIVE' || p.killSwitch) continue;
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
   * Open the slots the look-ahead window is missing. The walk visits EVERY
   * cadence time in [now, now + lookaheadDays] and creates the ones no slot
   * holds — a hole behind the newest slot (a slot moved forward by the owner,
   * a cadence raised after the window was filled) is refilled on the next
   * sweep, not never. A time that has a slot of ANY status stays as it is: a
   * SKIPPED time is the owner's or the cap's decision and stays empty, a
   * FAILED time keeps its FAILED row for the retry door. (programmeId,
   * scheduledFor) is unique, so a time a concurrent tick already filled is a
   * caught P2002 and a skipped iteration.
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

    // Every slot from now on, whatever its status: the ones that hold a time.
    const upcoming = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, scheduledFor: { gte: now } },
      orderBy: { scheduledFor: 'asc' },
      select: { id: true, scheduledFor: true, contentTypeKey: true, status: true },
    });
    const last = await this.prisma.contentSlot.findFirst({
      where: { workspaceId, programmeId: programme.id },
      orderBy: { scheduledFor: 'desc' },
      select: { scheduledFor: true, contentTypeKey: true },
    });
    let seedCursor = await this.prisma.contentSlot.count({ where: { workspaceId, programmeId: programme.id } });

    // Only the slots still on the calendar shape the type mix.
    const live = upcoming.filter((s) => WINDOW_SLOT_STATUSES.includes(s.status));
    const windowCounts: Record<string, number> = {};
    for (const s of live) windowCounts[s.contentTypeKey] = (windowCounts[s.contentTypeKey] ?? 0) + 1;
    let windowSize = live.length;
    const taken = new Set(upcoming.map((s) => s.scheduledFor.getTime()));
    let previousKey: string | null = last?.contentTypeKey ?? null;

    // Trends: one read per fill, no network filter (signals are GOOGLE /
    // TIKTOK / YOUTUBE feeds, not the social networks the programme posts to;
    // a Google trend is as good a hook for an Instagram reel as for anything).
    // The slots that want a hook rotate through the top few, so one fill does
    // not plan five riffs on the same signal.
    let brandKeywords: string[] | null = null;
    let usableTrends: TopTrend[] | null = null;
    let trendOrdinal = 0;
    const pickTrend = async (): Promise<TopTrend | null> => {
      if (usableTrends === null) {
        brandKeywords = brandKeywords ?? (await this.brandKeywords(workspaceId, programme));
        const top = await this.trends.top(TREND_REGION, { brandKeywords, limit: TREND_ROTATION, now });
        usableTrends = top.filter((t) => t.suggestion > TREND_MIN_SUGGESTION);
      }
      if (usableTrends.length === 0) return null;
      return usableTrends[trendOrdinal++ % usableTrends.length];
    };

    let cursor = now;
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
   * PRODUCING and READY slots follow their item. For a PRODUCING slot,
   * SCHEDULED / NEEDS_APPROVAL / PUBLISHED all mean the clips exist and the
   * gate is armed → READY (the learning service's `settle` takes READY →
   * PUBLISHED, so a PUBLISHED item is READY here and PUBLISHED one tick later
   * — the slot walks the same path either way). FAILED and SKIPPED carry the
   * item's verdict onto the slot from EITHER status: the publish gate can end
   * a READY slot's item without ever touching its post (brand safety → item
   * SKIPPED, no attachable media → item FAILED, a rejection from the campaign
   * panel), and `settle` only reads the post, so without this a READY slot
   * whose item died would sit READY for good, unskippable and unlearned.
   *
   * Before that, the orphans: a PRODUCING slot with NO item, older than the
   * reaper's revive delay, was claimed by a produce job that died between the
   * claim and the link write (the revived job finds the slot PRODUCING and
   * ends). Its concept says how far it got — promoted: the item exists and is
   * linked here (with the clips' cost, so the week's spend is right); decided
   * or untouched but never promoted: nothing was bought, the slot is FAILED
   * by name and the retry door discards the concept and plans again.
   */
  async reconcile(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<void> {
    await this.linkOrphans(workspaceId, programme, now);
    const slots = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, status: { in: ['PRODUCING', 'READY'] }, campaignItemId: { not: null } },
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
      const where = { id: slot.id, workspaceId, status: slot.status };
      if (slot.status === 'PRODUCING' && (item.status === 'SCHEDULED' || item.status === 'NEEDS_APPROVAL' || item.status === 'PUBLISHED')) {
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
        const error = (item.error ?? (slot.status === 'READY' ? 'ended by the publish gate' : 'campaign item skipped')).slice(0, 500);
        await this.prisma.contentSlot.updateMany({ where, data: { status: 'SKIPPED', error } });
        await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_SKIPPED', `Slot ${slot.contentTypeKey} skipped: ${error}.`, {
          slotId: slot.id, contentTypeKey: slot.contentTypeKey, campaignItemId: item.id, from: slot.status, error,
        });
      }
    }
  }

  private async linkOrphans(workspaceId: string, programme: ContentProgramme, now: Date): Promise<void> {
    const orphans = await this.prisma.contentSlot.findMany({
      where: {
        workspaceId, programmeId: programme.id, status: 'PRODUCING', campaignItemId: null,
        updatedAt: { lt: new Date(now.getTime() - ORPHAN_PRODUCING_MS) },
      },
    });
    for (const slot of orphans) {
      const where = { id: slot.id, workspaceId, status: 'PRODUCING', campaignItemId: null };
      const concept: { status: string; promotedItemId: string | null; shotPlan: unknown } | null = slot.conceptId
        ? await this.prisma.contentConcept.findFirst({ where: { id: slot.conceptId, workspaceId }, select: { status: true, promotedItemId: true, shotPlan: true } })
        : null;
      if (concept?.promotedItemId) {
        const production = (concept.shotPlan as { production?: { credits?: number; keyframes?: { credits?: number } } } | null)?.production;
        const clipCost = Math.max(0, Math.round((production?.credits ?? slot.quotedCredits ?? 0) - (production?.keyframes?.credits ?? 0)));
        await this.prisma.contentSlot.updateMany({ where, data: { campaignItemId: concept.promotedItemId, error: null, spentCredits: { increment: clipCost } } });
        await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_PRODUCING',
          `Slot ${slot.contentTypeKey} linked to item ${concept.promotedItemId} by the sweep: the produce job ended before it could write the link.`,
          { slotId: slot.id, contentTypeKey: slot.contentTypeKey, conceptId: slot.conceptId, campaignItemId: concept.promotedItemId, quotedCredits: slot.quotedCredits, spent: clipCost, recovered: true });
        continue;
      }
      const error = concept ? PRODUCTION_DID_NOT_START : 'concept missing';
      await this.prisma.contentSlot.updateMany({ where, data: { status: 'FAILED', error } });
      await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_FAILED',
        `Slot ${slot.contentTypeKey} failed: claimed for production but ${concept ? `its concept (${concept.status.toLowerCase()}) never became an item` : 'its concept is gone'}; retry it.`,
        { slotId: slot.id, contentTypeKey: slot.contentTypeKey, conceptId: slot.conceptId, conceptStatus: concept?.status ?? null, error, recovered: true });
    }
  }

  /**
   * The two circuit breakers.
   *
   * Fail streak: the three most recently SETTLED slots (by updatedAt, so a
   * future slot that is merely IDEATED cannot sit in front of the failures and
   * mask them) are all FAILED. Owner skips are not symptoms and are dropped
   * before counting. Checked against the last fail-streak ANOMALY_PAUSE (a
   * spend pause in between is a different reason and must not hide it) so a
   * resume does not trip again on the same three slots.
   *
   * Spend: this Istanbul week's real spend is past 120% of the cap. Once per
   * week — the sum cannot fall until the week rolls, so without the dedup the
   * owner's every resume would be undone at the next tick.
   */
  async checkAnomalies(workspaceId: string, programme: ContentProgramme, now = new Date()): Promise<void> {
    const settled: Array<{ id: string; status: string; error: string | null }> = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId: programme.id, status: { in: TERMINAL_SLOT_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      take: STREAK_SCAN,
      select: { id: true, status: true, error: true },
    });
    const recent = settled.filter((s) => !(s.status === 'SKIPPED' && (s.error ?? '').startsWith(OWNER_SKIP_PREFIX))).slice(0, ANOMALY_FAIL_STREAK);
    if (recent.length === ANOMALY_FAIL_STREAK && recent.every((s) => s.status === 'FAILED')) {
      const ids = recent.map((s) => s.id).sort();
      const previous = await this.prisma.contentProgrammeEvent.findFirst({
        where: { workspaceId, programmeId: programme.id, kind: 'ANOMALY_PAUSE', data: { path: ['reason'], equals: 'fail-streak' } },
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
      const already = await this.prisma.contentProgrammeEvent.findFirst({
        where: { workspaceId, programmeId: programme.id, kind: 'ANOMALY_PAUSE', data: { path: ['weekStart'], equals: weekStart.toISOString() } },
        select: { id: true },
      });
      if (already) return;
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
