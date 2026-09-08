import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ContentProgramme, ContentSlot, ContentType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ClaimedJob, JobHandlerResult, ScheduledJobRunnerService } from '../scheduling/scheduled-job-runner.service';
import { ContentConceptsService, PlannedConcept, ProgrammeGrounding } from '../content-concepts/content-concepts.service';
import { StoryboardService } from '../content-concepts/storyboard.service';
import { ConceptPromotionService } from '../content-concepts/concept-promotion.service';
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
/** The cap check happens BEFORE a quote exists, so it uses a rough estimate:
 *  the type's length at the video rate, plus a storyboard of three frames. */
export const ESTIMATE_CREDITS_PER_SEC = 3;
export const ESTIMATE_CREDITS_PER_FRAME = 3;
export const ESTIMATE_FRAMES = 3;
/** A slot held by the cap is looked at again this much later. */
export const CAP_RETRY_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CAP_ERROR = 'weekly credit cap';

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
 * THE PRODUCER — the two per-slot jobs the planner arms.
 *
 *   plan     (T − planLeadHours)     cap check → three concepts planned under
 *            the slot's type, trend and brief → the one whose hook the
 *            programme has not used lately is kept, the rest discarded →
 *            its storyboard is requested → slot IDEATED with the quote
 *   produce  (T − produceLeadHours)  cap check → the concept is approved BY
 *            THE PROGRAMME and promoted onto the campaign at the slot's own
 *            time → slot PRODUCING; the planner's reconcile takes it to READY
 *
 * The gap between the two is the owner's window: the storyboard can be redrawn
 * and the idea rewritten while nothing has been bought but frames. Neither job
 * has an approval gate — that is the design (K3) — but both refuse a paused or
 * killed programme, and both hold the weekly credit cap.
 *
 * A failure inside either job fails the SLOT (with the message on the row and
 * an event) rather than the job: a retried job would re-buy the same concept,
 * and the owner's remedy for a failed slot — regenerate, or skip — is on the
 * panel, not in the queue.
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

  /** This Istanbul week's committed credits (see `sumWeekSpend`). */
  async weekSpend(workspaceId: string, programmeId: string, now = new Date(), opts: { excludeSlotId?: string } = {}): Promise<WeekSpend> {
    const { weekStart, spent } = await sumWeekSpend(this.prisma, workspaceId, programmeId, now, opts);
    return { weekStart, spent };
  }

  /**
   * PLANNED → IDEATED. Returns a reschedule directive when the cap holds the
   * slot back (the job runs again in six hours); void otherwise. The slot is
   * skipped rather than held when another wait would run past the moment the
   * clips must be bought — a concept planned after produce time is money spent
   * on a slot that can no longer publish.
   */
  async planSlot(workspaceId: string, slotId: string, now = new Date()): Promise<JobHandlerResult> {
    const ctx = await this.load(workspaceId, slotId);
    if (!ctx || ctx.slot.status !== 'PLANNED') return;
    const { slot, programme } = ctx;
    if (programme.status !== 'ACTIVE' || programme.killSwitch) return;

    try {
      // Through the types service (workspace-scoped list) so a type id from
      // another workspace can never ground a slot here.
      const type = (await this.types.list(workspaceId)).find((t) => t.id === slot.contentTypeId);
      if (!type) throw new Error(`content type ${slot.contentTypeKey} no longer exists in this workspace`);

      const estimate = type.defaultDurationSec * ESTIMATE_CREDITS_PER_SEC + ESTIMATE_CREDITS_PER_FRAME * ESTIMATE_FRAMES;
      const { spent } = await this.weekSpend(workspaceId, programme.id, now, { excludeSlotId: slot.id });
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

      const others = batch.concepts.filter((c) => c.id !== chosen.id).map((c) => c.id);
      if (others.length) await this.discardConcepts(workspaceId, others, programme.id, 'programme: not selected', now);

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
        await this.discardConcepts(workspaceId, [chosen.id], programme.id, 'programme: slot changed while planning', now);
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
        { slotId: slot.id, contentTypeKey: slot.contentTypeKey, conceptId: chosen.id, hook: chosen.hook, quotedCredits, discarded: others, cold: batch.cold });
    } catch (e: any) {
      await this.fail(workspaceId, programme, slot, 'PLANNED', e);
    }
  }

  /**
   * IDEATED → PRODUCING. The programme's own verdict on the concept (recorded
   * as `programme:<id>`, so a human's later reading of the concept says who
   * decided), then promotion onto the campaign at the slot's time. The item
   * the promotion creates is what buys the clips and arms the publish gate.
   */
  async produceSlot(workspaceId: string, slotId: string, now = new Date()): Promise<void> {
    const ctx = await this.load(workspaceId, slotId);
    if (!ctx || ctx.slot.status !== 'IDEATED' || !ctx.slot.conceptId) return;
    const { slot, programme } = ctx;
    if (programme.status !== 'ACTIVE' || programme.killSwitch) return;
    const conceptId = slot.conceptId;

    try {
      const quote = slot.quotedCredits ?? 0;
      const { spent } = await this.weekSpend(workspaceId, programme.id, now, { excludeSlotId: slot.id });
      if (spent + quote > programme.weeklyCreditCap) {
        await this.discardConcepts(workspaceId, [conceptId], programme.id, 'programme: weekly credit cap', now);
        await this.skipForCap(workspaceId, programme, slot, spent, quote);
        return;
      }

      await this.concepts.decideByProgramme(workspaceId, conceptId, programme.id, programme.socialCampaignId);
      const { item } = await this.promotion.promote(workspaceId, conceptId, {
        socialCampaignId: programme.socialCampaignId,
        scheduledFor: slot.scheduledFor,
      });
      await this.prisma.contentSlot.updateMany({
        where: { id: slot.id, workspaceId, status: 'IDEATED' },
        data: { status: 'PRODUCING', campaignItemId: item.id, error: null },
      });
      await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_PRODUCING',
        `Slot ${slot.contentTypeKey} in production: item ${item.id} at ${slot.scheduledFor.toISOString()}.`,
        { slotId: slot.id, contentTypeKey: slot.contentTypeKey, conceptId, campaignItemId: item.id, quotedCredits: slot.quotedCredits });
    } catch (e: any) {
      await this.fail(workspaceId, programme, slot, 'IDEATED', e);
    }
  }

  // ───────────────────────────────────────────────────────── internals

  private async load(workspaceId: string, slotId: string): Promise<{ slot: ContentSlot; programme: ContentProgramme } | null> {
    const slot = await this.prisma.contentSlot.findFirst({ where: { id: slotId, workspaceId } });
    if (!slot) return null;
    const programme = await this.prisma.contentProgramme.findFirst({ where: { id: slot.programmeId, workspaceId } });
    if (!programme) return null;
    return { slot, programme };
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

  /** Only PROPOSED rows move: a concept a human approved or discarded in the
   *  window keeps that person's verdict. */
  private async discardConcepts(workspaceId: string, ids: string[], programmeId: string, note: string, now: Date): Promise<void> {
    await this.prisma.contentConcept.updateMany({
      where: { id: { in: ids }, workspaceId, status: 'PROPOSED' },
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

  private async fail(workspaceId: string, programme: ContentProgramme, slot: ContentSlot, from: string, e: any): Promise<void> {
    const error = String(e?.message ?? e).slice(0, 500);
    this.logger.warn(`slot ${slot.id} (${from}) failed: ${error}`);
    await this.prisma.contentSlot.updateMany({
      where: { id: slot.id, workspaceId, status: from },
      data: { status: 'FAILED', error },
    });
    await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_FAILED', `Slot ${slot.contentTypeKey} failed while ${from === 'PLANNED' ? 'planning' : 'producing'}: ${error}`, {
      slotId: slot.id, contentTypeKey: slot.contentTypeKey, from, error,
    });
  }
}

/** The quote the concept planner wrote onto the plan, when it wrote one. */
function quoteOf(concept: PlannedConcept): number | null {
  const credits = concept.shotPlan?.production?.credits;
  return typeof credits === 'number' && Number.isFinite(credits) ? Math.round(credits) : null;
}
