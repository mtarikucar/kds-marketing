import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ContentProgramme, ContentSlot, ContentType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ClaimedJob, JobHandlerResult, ScheduledJobRunnerService } from '../scheduling/scheduled-job-runner.service';
import { ContentConceptsService, PlannedConcept, ProgrammeGrounding } from '../content-concepts/content-concepts.service';
import { StoryboardService } from '../content-concepts/storyboard.service';
import { ConceptPromotionService } from '../content-concepts/concept-promotion.service';
import { creditCost } from '../ai/ai-credit-costs';
import { DEFAULT_KEYFRAME_MODEL, DEFAULT_VIDEO_MODEL, animateModelFor, estimateMediaCredits } from '../ai/media/media-models.config';
import type { ShotProduction } from '../video/video-pipeline.service';
import { tokenize } from '../trends/trend-score.util';
import { ContentProgrammeService } from './content-programme.service';
import { ContentTypesService, readBeats } from './content-types.service';
import {
  CONTENT_SLOT_PLAN_KIND,
  CONTENT_SLOT_PRODUCE_KIND,
  slotProduceDedup,
  sumWeekSpend,
} from './programme-planner.service';

/** How many concepts a slot asks for; one is kept, the rest discarded. Three
 *  is enough to dodge a hook the programme already used without paying for a
 *  batch of five. */
export const SLOT_CONCEPT_COUNT = 3;
/** A concept whose hook shares this much of its words with a recent slot's
 *  hook is a rewrite; the programme has already said that. */
export const HOOK_JACCARD_MAX = 0.5;
/** How many past slots' hooks the distinctness check reads. */
export const HOOK_HISTORY = 20;
/** Frames assumed for the plan-time estimate when a type declares no beats. */
export const ESTIMATE_FRAMES = 3;
/** A slot held by the cap is looked at again this much later. */
export const CAP_RETRY_MS = 6 * 60 * 60 * 1000;
/** A slot held by a pause (programme or lane) is looked at again this much later. */
export const PAUSE_RETRY_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CAP_ERROR = 'weekly credit cap';
export const MISSED_WHILE_PAUSED = 'missed while paused';
export const NO_QUOTE_ERROR = 'no quote on the concept';

const hours = (h: number) => h * HOUR_MS;

export interface WeekSpend {
  weekStart: Date;
  spent: number;
}

/** Token Jaccard of two hooks, on the same folding the trend scorer uses. */
export function hookSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** The first concept whose hook is far enough from every recent hook; the
 *  first of the batch when none is (the batch was already checked for
 *  distinctness within itself, so "first" is a real choice, not a shrug). */
export function pickDistinctConcept<T extends { hook: string }>(concepts: T[], recentHooks: string[]): T | null {
  if (concepts.length === 0) return null;
  for (const c of concepts) {
    const worst = recentHooks.reduce((m, h) => Math.max(m, hookSimilarity(c.hook, h)), 0);
    if (worst < HOOK_JACCARD_MAX) return c;
  }
  return concepts[0];
}

/**
 * The credits a slot of this type will need, estimated BEFORE any concept
 * exists: the clips at the rate of the model that will actually animate the
 * campaign's chosen video model, one keyframe per beat at the keyframe model's
 * flat rate, and the concept batch itself. Priced through the same catalogue
 * the quote is later priced through, so a premium campaign model is refused
 * at plan time rather than admitted on a generic rate and refused at produce
 * time with the frames already drawn.
 */
export function estimateSlotCredits(type: Pick<ContentType, 'defaultDurationSec' | 'structure'>, campaignVideoModel: string | null): number {
  const animator = animateModelFor(campaignVideoModel ?? DEFAULT_VIDEO_MODEL);
  const beats = readBeats(type.structure).length || ESTIMATE_FRAMES;
  return (
    estimateMediaCredits(animator, { durationSec: type.defaultDurationSec }) +
    estimateMediaCredits(DEFAULT_KEYFRAME_MODEL, {}) * beats +
    creditCost('content.concepts')
  );
}

/**
 * THE PRODUCER — the two per-slot jobs the planner arms.
 *
 *   plan     (T − planLeadHours)     cap check → three concepts planned under
 *            the slot's type, trend and brief → the one whose hook the
 *            programme has not used lately is kept, the rest discarded →
 *            its storyboard is requested → slot IDEATED with the quote
 *   produce  (T − produceLeadHours)  cap check → the slot is CLAIMED
 *            (IDEATED → PRODUCING) → the concept is approved BY THE PROGRAMME
 *            and promoted onto the campaign at the slot's own time; the
 *            planner's reconcile takes it to READY
 *
 * The gap between the two is the owner's window: the storyboard can be redrawn
 * and the idea rewritten while nothing has been bought but frames. Neither job
 * has an approval gate — that is the design (K3) — but both hold the weekly
 * credit cap, and both answer a pause with a WAIT, not a shrug: the runner
 * marks a job that returns nothing DONE, so a job that merely returned while
 * the programme was paused would strand its slot for good. Paused programme,
 * paused lane → the job reschedules itself an hour on while the slot's
 * produce time is still ahead; once it is behind, the slot is SKIPPED as
 * missed. Killed → the job ends (kill() has already swept the slots).
 *
 * Money is recorded as it is spent, on the slot's `spentCredits`: the concept
 * batch and the frames at plan time, the clips at produce time. The weekly
 * cap is checked against that sum — including the frames of slots that were
 * later skipped and the half-bought clips of slots that failed — never
 * against the quotes of live slots alone.
 *
 * A failure inside either job fails the SLOT (with the message on the row and
 * an event) rather than the job: a retried job would re-buy the same concept,
 * and the owner's remedy for a failed slot — retry, regenerate, or skip — is
 * on the panel, not in the queue.
 */
@Injectable()
export class SlotProducerService implements OnModuleInit {
  private readonly logger = new Logger(SlotProducerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly programmes: ContentProgrammeService,
    private readonly types: ContentTypesService,
    private readonly concepts: ContentConceptsService,
    private readonly storyboard: StoryboardService,
    private readonly promotion: ConceptPromotionService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CONTENT_SLOT_PLAN_KIND, (job: ClaimedJob) =>
      this.planSlot(String(job.payload.workspaceId), String(job.payload.slotId)),
    );
    this.runner.registerHandler(CONTENT_SLOT_PRODUCE_KIND, (job: ClaimedJob) =>
      this.produceSlot(String(job.payload.workspaceId), String(job.payload.slotId)),
    );
  }

  /**
   * The real spend of the Istanbul week that contains `at` (see `sumWeekSpend`).
   * The cap checks pass the SLOT's `scheduledFor`, never the job's clock: a
   * slot's spend is booked into the week it publishes in, and the two per-slot
   * jobs run up to `planLeadHours` before that — a Monday slot's jobs run on
   * the weekend before. Checking the job's week would hold Monday against a
   * week that is already closing, and let a long lead pull every week of the
   * look-ahead into one night's spend.
   */
  async weekSpend(workspaceId: string, programmeId: string, at = new Date(), opts: { excludeSlotId?: string } = {}): Promise<WeekSpend> {
    const { weekStart, spent } = await sumWeekSpend(this.prisma, workspaceId, programmeId, at, opts);
    return { weekStart, spent };
  }

  /**
   * PLANNED → IDEATED. Returns a reschedule directive when the cap or a pause
   * holds the slot back; void otherwise. The slot is skipped rather than held
   * when another wait would run past the moment the clips must be bought — a
   * concept planned after produce time is money spent on a slot that can no
   * longer publish.
   */
  async planSlot(workspaceId: string, slotId: string, now = new Date()): Promise<JobHandlerResult> {
    const ctx = await this.load(workspaceId, slotId);
    if (!ctx || ctx.slot.status !== 'PLANNED') return;
    const { slot, programme } = ctx;
    const hold = await this.holdForProgramme(workspaceId, programme, slot, now);
    if (hold !== 'go') return hold === 'end' ? undefined : hold;

    try {
      // Through the types service (workspace-scoped list) so a type id from
      // another workspace can never ground a slot here.
      const type = (await this.types.list(workspaceId)).find((t) => t.id === slot.contentTypeId);
      if (!type) throw new Error(`content type ${slot.contentTypeKey} no longer exists in this workspace`);

      const campaign = await this.campaign(workspaceId, programme);
      // The lane not running (paused by hand, cancelled, gone): a concept
      // planned now is a batch and frames bought for a slot that will be
      // skipped as missed at publish time. Wait for the lane — nothing bought.
      if (campaign?.status !== 'ACTIVE') {
        const lane = await this.holdForLane(workspaceId, programme, slot, campaign?.status ?? null, now);
        return lane === 'end' ? undefined : lane;
      }
      const estimate = estimateSlotCredits(type, campaign.defaultVideoModel ?? null);
      // The slot's own spend counts: a retried slot already paid for a batch.
      // Bucketed by the slot's week (see `weekSpend`).
      const { spent } = await this.weekSpend(workspaceId, programme.id, slot.scheduledFor);
      if (spent + estimate > programme.weeklyCreditCap) {
        const produceAt = slot.scheduledFor.getTime() - hours(programme.produceLeadHours);
        if (produceAt <= now.getTime() + CAP_RETRY_MS) {
          await this.skipForCap(workspaceId, programme, slot, spent, estimate);
          return;
        }
        await this.programmes.logEvent(workspaceId, programme.id, 'CAP_HELD',
          `Slot ${slot.contentTypeKey} held: ${spent} + ~${estimate} credits would pass the ${programme.weeklyCreditCap}-credit week; trying again in 6h.`,
          { slotId: slot.id, contentTypeKey: slot.contentTypeKey, spent, estimate, cap: programme.weeklyCreditCap });
        return { reschedule: { runAt: new Date(now.getTime() + CAP_RETRY_MS) } };
      }

      const grounding = await this.grounding(programme, slot, type);
      const batch = await this.concepts.planConcepts(workspaceId, {
        idea: slot.idea,
        count: SLOT_CONCEPT_COUNT,
        socialCampaignId: programme.socialCampaignId,
        personaId: programme.personaId ?? undefined,
        createdById: programme.createdById,
        programme: grounding,
      });
      const recentHooks = await this.recentHooks(workspaceId, programme.id, slot.id);
      const chosen = pickDistinctConcept(batch.concepts, recentHooks);
      if (!chosen) throw new Error('the concept planner returned no concept');

      // The money is spent now — the batch was charged and the frames will be
      // drawn by the storyboard job — and it stays on the row whatever happens
      // to the slot next (edited, skipped, capped): the week paid for it.
      // Out of scope by design: a storyboard REDRAW a person or an agent asks
      // for on this concept during the edit window is billed to the workspace
      // like any other frame but is NOT booked here, so it sits outside the
      // weekly cap — the cap is the programme's own spending, not the owner's.
      const planCost = creditCost('content.concepts') + (productionOf(chosen)?.keyframes?.credits ?? 0);
      await this.prisma.contentSlot.updateMany({ where: { id: slot.id, workspaceId }, data: { spentCredits: { increment: planCost } } });

      const others = batch.concepts.filter((c) => c.id !== chosen.id).map((c) => c.id);
      if (others.length) await this.discardConcepts(workspaceId, others, programme.id, slot.id, 'programme: not selected', now);

      // Frames are optional: `produce` draws any that are missing. A storyboard
      // that cannot be requested now must not cost the slot its concept.
      try {
        await this.storyboard.request(workspaceId, chosen.id, `programme:${programme.id}`);
      } catch (e: any) {
        this.logger.warn(`slot ${slot.id}: storyboard not requested: ${String(e?.message ?? e)}`);
      }

      const quotedCredits = quoteOf(chosen);
      const { count } = await this.prisma.contentSlot.updateMany({
        where: { id: slot.id, workspaceId, status: 'PLANNED' },
        data: { status: 'IDEATED', conceptId: chosen.id, quotedCredits, error: null },
      });
      if (count === 0) {
        // Edited or skipped between the load and the write: the owner's move
        // stands, and the concept it would have used goes with the others.
        await this.discardConcepts(workspaceId, [chosen.id], programme.id, slot.id, 'programme: slot changed while planning', now);
        return;
      }
      // Re-arm produce so a slot planned inside its lead window (both jobs
      // clamped to "now") is produced AFTER it is ideated, not before.
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CONTENT_SLOT_PRODUCE_KIND,
        runAt: new Date(Math.max(now.getTime(), slot.scheduledFor.getTime() - hours(programme.produceLeadHours))),
        payload: { workspaceId, slotId: slot.id, programmeId: programme.id },
        dedupKey: slotProduceDedup(slot.id),
      });
      await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_IDEATED',
        `Slot ${slot.contentTypeKey} ideated: "${chosen.title}" (${chosen.angle}), quote ${quotedCredits ?? '?'} credits, ${others.length} alternative(s) discarded.`,
        { slotId: slot.id, contentTypeKey: slot.contentTypeKey, conceptId: chosen.id, hook: chosen.hook, quotedCredits, spent: planCost, discarded: others, cold: batch.cold });
    } catch (e: any) {
      await this.fail(workspaceId, programme, slot, 'PLANNED', e);
    }
  }

  /**
   * IDEATED → PRODUCING. The slot is claimed FIRST (a conditional write on
   * IDEATED), so an owner edit or skip racing this job either lands before the
   * claim — and the job finds nothing to claim — or is refused by the editor
   * because the slot is already PRODUCING. Only then the programme's own
   * verdict on the concept (recorded as `programme:<id>`, so a human's later
   * reading of the concept says who decided), then promotion onto the campaign
   * at the slot's time. The item the promotion creates is what buys the clips
   * and arms the publish gate.
   */
  async produceSlot(workspaceId: string, slotId: string, now = new Date()): Promise<JobHandlerResult> {
    const ctx = await this.load(workspaceId, slotId);
    if (!ctx || ctx.slot.status !== 'IDEATED' || !ctx.slot.conceptId) return;
    const { slot, programme } = ctx;
    const hold = await this.holdForProgramme(workspaceId, programme, slot, now);
    if (hold !== 'go') return hold === 'end' ? undefined : hold;
    const conceptId = slot.conceptId;

    // The lane paused by hand (the campaign, not the programme): the item the
    // promotion would create sits SCHEDULED behind a gate that refuses to
    // fire, with its clips bought. Wait for the lane instead, once in the log.
    const campaign = await this.campaign(workspaceId, programme);
    if (campaign?.status === 'PAUSED') {
      const lane = await this.holdForLane(workspaceId, programme, slot, campaign.status, now);
      return lane === 'end' ? undefined : lane;
    }

    let clipCost: number;
    try {
      // No quote means nothing to hold the cap against: refuse, do not guess.
      if (slot.quotedCredits === null || slot.quotedCredits === undefined) {
        await this.discardConcepts(workspaceId, [conceptId], programme.id, slot.id, `programme: ${NO_QUOTE_ERROR}`, now);
        throw new Error(NO_QUOTE_ERROR);
      }
      // What this job will buy: the clips — the quote minus the frames the
      // plan job already booked. The check is Σ spent of the slot's week
      // INCLUDING this slot's own batch and frames, plus the clips: the sum
      // the week will actually close on, so it can never close above the cap.
      const production = await this.productionOfConcept(workspaceId, conceptId);
      clipCost = Math.max(0, Math.round((production?.credits ?? quote0(slot)) - (production?.keyframes?.credits ?? 0)));
      const { spent } = await this.weekSpend(workspaceId, programme.id, slot.scheduledFor);
      if (spent + clipCost > programme.weeklyCreditCap) {
        await this.discardConcepts(workspaceId, [conceptId], programme.id, slot.id, 'programme: weekly credit cap', now);
        await this.skipForCap(workspaceId, programme, slot, spent, clipCost);
        return;
      }

      // The claim pins the time as well as the status: an owner move that
      // landed after the load would otherwise be overridden on the item, which
      // is promoted at the time THIS job read.
      const { count } = await this.prisma.contentSlot.updateMany({
        where: { id: slot.id, workspaceId, status: 'IDEATED', scheduledFor: slot.scheduledFor },
        data: { status: 'PRODUCING' },
      });
      // Edited or skipped under the job: the owner's move stands, nothing bought.
      if (count === 0) return;
    } catch (e: any) {
      await this.fail(workspaceId, programme, slot, 'IDEATED', e);
      return;
    }

    // The link (campaignItemId + the clips' spend) is written as the very
    // next statement after the promotion: between the two the item exists,
    // buys clips and arms its gate, while the slot says nothing about it. A
    // link write that throws is tried once more; if it still fails the slot is
    // FAILED with the item's id in the error — the reconcile sweep and the
    // owner can then find the item, and the retry door will not buy a second.
    let item: { id: string } | null = null;
    try {
      await this.concepts.decideByProgramme(workspaceId, conceptId, programme.id, programme.socialCampaignId);
      ({ item } = await this.promotion.promote(workspaceId, conceptId, {
        socialCampaignId: programme.socialCampaignId,
        scheduledFor: slot.scheduledFor,
      }));
      await this.linkItem(workspaceId, slot, item.id, clipCost);
    } catch (e: any) {
      if (!item) {
        await this.fail(workspaceId, programme, slot, 'PRODUCING', e);
        return;
      }
      try {
        await this.linkItem(workspaceId, slot, item.id, clipCost);
      } catch (again: any) {
        await this.fail(workspaceId, programme, slot, 'PRODUCING',
          new Error(`item ${item.id} produced but not linked: ${String(again?.message ?? again)}`),
          { campaignItemId: item.id });
        return;
      }
    }
    await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_PRODUCING',
      `Slot ${slot.contentTypeKey} in production: item ${item.id} at ${slot.scheduledFor.toISOString()}.`,
      { slotId: slot.id, contentTypeKey: slot.contentTypeKey, conceptId, campaignItemId: item.id, quotedCredits: slot.quotedCredits, spent: clipCost });
  }

  // ───────────────────────────────────────────────────────── internals

  private async load(workspaceId: string, slotId: string): Promise<{ slot: ContentSlot; programme: ContentProgramme } | null> {
    const slot = await this.prisma.contentSlot.findFirst({ where: { id: slotId, workspaceId } });
    if (!slot) return null;
    const programme = await this.prisma.contentProgramme.findFirst({ where: { id: slot.programmeId, workspaceId } });
    if (!programme) return null;
    return { slot, programme };
  }

  private campaign(workspaceId: string, programme: ContentProgramme): Promise<{ status: string; defaultVideoModel: string | null } | null> {
    return this.prisma.socialCampaign.findFirst({
      where: { id: programme.socialCampaignId, workspaceId },
      select: { status: true, defaultVideoModel: true },
    });
  }

  /**
   * What the programme's state means for this job: `go`, `end` (killed — the
   * job dies; kill() swept the slots), or a reschedule directive (paused —
   * wait an hour). A paused slot whose produce time has passed is skipped as
   * missed instead: it can no longer publish on time whatever happens next.
   */
  private async holdForProgramme(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, now: Date): Promise<'go' | 'end' | JobHandlerResult> {
    if (programme.status === 'ACTIVE' && !programme.killSwitch) return 'go';
    if (programme.killSwitch || programme.status === 'KILLED') return 'end';
    if (programme.status !== 'PAUSED') return 'end';
    const produceAt = slot.scheduledFor.getTime() - hours(programme.produceLeadHours);
    if (produceAt <= now.getTime()) {
      await this.skipAsMissed(workspaceId, programme, slot, now, 'programme paused');
      return 'end';
    }
    return this.retryLater(workspaceId, programme, slot, now);
  }

  /**
   * The lane (the campaign, not the programme) is not running. The item a
   * promotion would create sits SCHEDULED behind a gate that refuses to fire,
   * with its clips bought; a concept planned now is a batch bought for a slot
   * that will be missed. Wait for the lane instead, once in the log per slot.
   * The lane may come back any hour, and the clips can still be made up to
   * the publish moment itself — so the wait runs to scheduledFor, not to the
   * produce lead the programme's own pause is held to.
   */
  private async holdForLane(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, campaignStatus: string | null, now: Date): Promise<'end' | JobHandlerResult> {
    if (slot.scheduledFor.getTime() <= now.getTime()) {
      await this.skipAsMissed(workspaceId, programme, slot, now, 'lane paused');
      return 'end';
    }
    const already = await this.prisma.contentProgrammeEvent.findFirst({
      where: { workspaceId, programmeId: programme.id, kind: 'LANE_PAUSED', data: { path: ['slotId'], equals: slot.id } },
      select: { id: true },
    });
    if (!already) {
      const state = campaignStatus ? campaignStatus.toLowerCase() : 'gone';
      await this.programmes.logEvent(workspaceId, programme.id, 'LANE_PAUSED',
        `Slot ${slot.contentTypeKey} is waiting: the programme's campaign is ${state}, so nothing is bought until it runs again.`,
        { slotId: slot.id, contentTypeKey: slot.contentTypeKey, socialCampaignId: programme.socialCampaignId, campaignStatus });
    }
    return this.retryLater(workspaceId, programme, slot, now);
  }

  /** The item onto the slot, and the clips onto its spend. A write that finds
   *  the slot no longer PRODUCING is a failure, not a shrug: the item exists. */
  private async linkItem(workspaceId: string, slot: ContentSlot, itemId: string, clipCost: number): Promise<void> {
    const { count } = await this.prisma.contentSlot.updateMany({
      where: { id: slot.id, workspaceId, status: 'PRODUCING' },
      data: { campaignItemId: itemId, error: null, spentCredits: { increment: clipCost } },
    });
    if (count === 0) throw new Error('the slot left PRODUCING before the item was linked');
  }

  private retryLater(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, now: Date): JobHandlerResult {
    return { reschedule: { runAt: new Date(now.getTime() + PAUSE_RETRY_MS), payload: { workspaceId, slotId: slot.id, programmeId: programme.id } } };
  }

  private async skipAsMissed(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, now: Date, why: string): Promise<void> {
    if (slot.conceptId) await this.discardConcepts(workspaceId, [slot.conceptId], programme.id, slot.id, `programme: ${MISSED_WHILE_PAUSED}`, now);
    await this.prisma.contentSlot.updateMany({
      where: { id: slot.id, workspaceId, status: slot.status },
      data: { status: 'SKIPPED', error: MISSED_WHILE_PAUSED },
    });
    await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_SKIPPED',
      `Slot ${slot.contentTypeKey} skipped: its produce time passed while the ${why === 'lane paused' ? 'campaign' : 'programme'} was paused.`,
      { slotId: slot.id, contentTypeKey: slot.contentTypeKey, from: slot.status, reason: MISSED_WHILE_PAUSED, why, scheduledFor: slot.scheduledFor.toISOString() });
  }

  private async productionOfConcept(workspaceId: string, conceptId: string): Promise<ShotProduction | null> {
    const row = await this.prisma.contentConcept.findFirst({ where: { id: conceptId, workspaceId }, select: { shotPlan: true } });
    const plan = (row?.shotPlan ?? null) as { production?: ShotProduction } | null;
    return plan?.production ?? null;
  }

  private async grounding(programme: ContentProgramme, slot: ContentSlot, type: ContentType): Promise<ProgrammeGrounding> {
    let trend: ProgrammeGrounding['trend'];
    if (slot.trendTitle) {
      const signal = slot.trendSignalId
        ? await this.prisma.trendSignal.findFirst({ where: { id: slot.trendSignalId }, select: { kind: true, network: true } })
        : null;
      trend = { title: slot.trendTitle, kind: signal?.kind ?? 'TOPIC', network: signal?.network ?? 'ALL' };
    }
    return {
      programmeId: programme.id,
      slotId: slot.id,
      contentType: {
        key: type.key,
        name: type.name,
        description: type.description,
        structure: readBeats(type.structure),
        defaultDurationSec: type.defaultDurationSec,
      },
      trend,
      brief: programme.brief,
    };
  }

  /** The hooks of the programme's last HOOK_HISTORY slots that got a concept. */
  private async recentHooks(workspaceId: string, programmeId: string, slotId: string): Promise<string[]> {
    const slots: Array<{ conceptId: string | null }> = await this.prisma.contentSlot.findMany({
      where: { workspaceId, programmeId, id: { not: slotId }, conceptId: { not: null } },
      orderBy: { scheduledFor: 'desc' },
      take: HOOK_HISTORY,
      select: { conceptId: true },
    });
    const ids = slots.map((s) => s.conceptId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    const concepts: Array<{ hook: string }> = await this.prisma.contentConcept.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { hook: true },
    });
    return concepts.map((c) => c.hook);
  }

  /**
   * The slot's own concepts that never became an item: PROPOSED rows, and
   * APPROVED rows the programme decided but never promoted (a promotion that
   * threw after the verdict). A promoted concept keeps its verdict — its item
   * is the thing to deal with, not the concept — and only this slot's rows
   * move, so an id from elsewhere can never be discarded through here. No
   * human verdict is overwritten: the review door refuses programme concepts,
   * so an APPROVED programme concept was approved by the programme.
   */
  private async discardConcepts(workspaceId: string, ids: string[], programmeId: string, slotId: string, note: string, now: Date): Promise<void> {
    await this.prisma.contentConcept.updateMany({
      where: { id: { in: ids }, workspaceId, slotId, status: { in: ['PROPOSED', 'APPROVED'] }, promotedItemId: null },
      data: { status: 'DISCARDED', reviewedAt: now, reviewedById: `programme:${programmeId}`, reviewNote: note },
    });
  }

  private async skipForCap(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, spent: number, wanted: number): Promise<void> {
    await this.prisma.contentSlot.updateMany({
      where: { id: slot.id, workspaceId, status: slot.status },
      data: { status: 'SKIPPED', error: CAP_ERROR },
    });
    await this.programmes.logEvent(workspaceId, programme.id, 'CAP_SKIPPED',
      `Slot ${slot.contentTypeKey} skipped: ${spent} + ${wanted} credits would pass the ${programme.weeklyCreditCap}-credit week and there is no time left to wait.`,
      { slotId: slot.id, contentTypeKey: slot.contentTypeKey, spent, wanted, cap: programme.weeklyCreditCap, scheduledFor: slot.scheduledFor.toISOString() });
  }

  /** `extra` rides on the FAILED write: the item id of a produced-but-unlinked
   *  slot, so the retry door goes through regenerate instead of buying a
   *  second item for the same time. */
  private async fail(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, from: string, e: any, extra: { campaignItemId?: string } = {}): Promise<void> {
    const error = String(e?.message ?? e).slice(0, 500);
    this.logger.warn(`slot ${slot.id} (${from}) failed: ${error}`);
    await this.prisma.contentSlot.updateMany({
      where: { id: slot.id, workspaceId, status: from },
      data: { status: 'FAILED', error, ...extra },
    });
    await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_FAILED', `Slot ${slot.contentTypeKey} failed while ${from === 'PLANNED' ? 'planning' : 'producing'}: ${error}`, {
      slotId: slot.id, contentTypeKey: slot.contentTypeKey, from, error, ...extra,
    });
  }
}

/** The production block the concept planner wrote onto the plan, when it did. */
function productionOf(concept: PlannedConcept): ShotProduction | null {
  const production = (concept.shotPlan as { production?: ShotProduction } | undefined)?.production;
  return production && typeof production.credits === 'number' ? production : null;
}

/** The quote the concept planner wrote onto the plan, when it wrote one. */
function quoteOf(concept: PlannedConcept): number | null {
  const credits = productionOf(concept)?.credits;
  return typeof credits === 'number' && Number.isFinite(credits) ? Math.round(credits) : null;
}

/** The slot's quote as a number; only reached after the null check above. */
const quote0 = (slot: ContentSlot): number => slot.quotedCredits ?? 0;
