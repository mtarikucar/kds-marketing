import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaGenService } from '../ai/media/media-gen.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ClaimedJob,
  JobHandlerResult,
  ScheduledJobRunnerService,
} from '../scheduling/scheduled-job-runner.service';
import { Cadence, nextCadenceSlot } from '../social-campaigns/cadence.util';
import type { ShotPlan } from '../video/video-pipeline.service';

export const CONCEPT_PRODUCE_KIND = 'content.concept.produce';
export const produceDedup = (itemId: string) => `content-concept-produce-${itemId}`;

/**
 * How long to wait for a free generation slot, and how many times.
 *
 * `MediaGenService` refuses a request once `MEDIA_GEN_MAX_INFLIGHT` (4)
 * generations are already running, and a five-beat concept therefore CANNOT be
 * submitted in one pass — this is not an edge case, it is the owner's own
 * reference concept. A refusal for that reason is a WAIT, not a failure.
 *
 * It needs its own bound, because the runner's reschedule directive resets the
 * job row's `attempts` to 0 (`scheduled-job-runner.service.ts`), so the usual
 * maxAttempts backstop does not apply to a self-rescheduling chain. Without
 * this an item whose workspace keeps its queue permanently full would spin
 * forever and report nothing. {@link PRODUCE_MAX_WAITS} waits at
 * {@link PRODUCE_WAIT_MS} is about an hour — comfortably longer than
 * `MEDIA_GEN_MAX_AGE_MS` (1h), the age at which the media sweep reaps an
 * abandoned generation and frees its slot, so a legitimately busy queue always
 * gets a chance to drain before this gives up.
 */
export const PRODUCE_WAIT_MS = Number(process.env.CONCEPT_PRODUCE_WAIT_MS ?? 2 * 60 * 1000);
export const PRODUCE_MAX_WAITS = Number(process.env.CONCEPT_PRODUCE_MAX_WAITS ?? 30);

/** When the campaign's cadence has no slot left, the promoted item still needs
 *  a timestamp. A day out is far enough not to fire before a human looks and
 *  near enough not to look like a mistake — and refusing an APPROVED concept
 *  over an exhausted cadence would throw the approved work away. */
const NO_SLOT_FALLBACK_MS = 24 * 60 * 60 * 1000;

/**
 * The campaign statuses a concept may be produced into.
 *
 * A MONEY guard, not a tidiness one. Production buys one clip per beat, and the
 * item it produces is only ever published by
 * `SocialCampaignsService.confirmItem`, which opens with
 * `if (c.status !== 'ACTIVE')` and — for everything except PAUSED — returns with
 * no reschedule, no error and no trace. A concept produced into a DRAFT campaign
 * is therefore bought in full, reaches NEEDS_APPROVAL, is approved by a human to
 * SCHEDULED, and parks there forever: money spent, no video published, no reason
 * recorded anywhere.
 *
 * That was not hypothetical. DRAFT is the ONLY campaign an agent can create
 * (`jeeta.create_social_campaign`: "activation is deliberately not available to
 * agents"), so the agent-driven path led straight into it.
 *
 * PAUSED is IN, and the asymmetry is the point rather than an oversight: it is
 * the one non-ACTIVE status the gate actually handles, rescheduling itself
 * hourly so a resume publishes the item it has been holding. COMPLETED and
 * CANCELLED are refused for DRAFT's reason — nothing puts them back to ACTIVE.
 *
 * The generic path has always had this guard: `generateItem` opens with
 * `item.campaign.status !== 'ACTIVE'`. The spend path is the one that dropped it.
 */
const PRODUCIBLE_CAMPAIGN_STATUSES: readonly string[] = ['ACTIVE', 'PAUSED'];

/** Item statuses from which re-driving the produce queue is meaningful. Only
 *  GENERATING: it is the state `produce()` acts on, the state a promoted item is
 *  created in, and — because `REGENERATABLE_STATES` excludes it — the one state
 *  no other surface in the product can reach. */
const RESCUABLE_ITEM_STATUS = 'GENERATING';

export interface PromoteResult {
  item: { id: string; status: string; socialCampaignId: string; scheduledFor: Date };
  /** False when an item already existed — the caller can tell a no-op apart
   *  from work without comparing timestamps. */
  created: boolean;
}

/** `MediaGenService` throws this as a BadRequest carrying a `code`. */
function isQueueFull(e: unknown): boolean {
  if (!(e instanceof HttpException)) return false;
  const body = e.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: string }).code === 'MEDIA_GEN_TOO_MANY';
}

function reason(e: unknown): string {
  const body = e instanceof HttpException ? e.getResponse() : null;
  if (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string') {
    return (body as { message: string }).message;
  }
  return String((e as Error)?.message ?? e);
}

/**
 * İçerik üretim hattı, aşama 2 — an APPROVED concept becomes produced content.
 *
 * ## Why the clips are NOT generated through `jeeta.generate_video`
 *
 * The obvious design is "the agent approves the concept, then calls
 * `generate_video` once per shot". Measured, it cannot work:
 *
 *  - `generate_video` is `requiresApproval: true`, so in this workspace's
 *    APPROVAL mode each of N clips raises its OWN approval card. The human gate
 *    the owner asked for is one gate on the idea, not five on its beats.
 *  - The approval executor returns the tool's result to the APPROVER'S HTTP
 *    response, not to the agent's turn, so the `assetId` never reaches the
 *    caller that would have to record it on the item.
 *  - `MEDIA_GEN_MAX_INFLIGHT` is 4, so a five-beat concept cannot be submitted
 *    in one turn at all.
 *
 * Promotion therefore happens SERVER-SIDE, where the `assetId` is in hand and
 * the item row is there to write it onto. The human decision stays exactly
 * where the owner put it: once, on the concept.
 *
 * ## Idempotency
 *
 * `promote` is safe to run any number of times, at three depths:
 *
 *  1. `ContentConcept.promotedItemId` short-circuits the common repeat without
 *     touching the campaign at all.
 *  2. `SocialCampaignItem.contentConceptId` is UNIQUE, so two concurrent
 *     promotions cannot both insert — the read in (1) cannot see an uncommitted
 *     row, so only the database can settle this.
 *  3. The loser of that race catches P2002 and reads the winner's item back
 *     rather than surfacing a constraint violation as a 500.
 *
 * `produce` is idempotent on a different axis: its cursor is
 * `item.generatedAssetIds.length`, which is the number of clips ALREADY PAID
 * FOR. A retry resumes at the next unproduced beat instead of re-buying the
 * ones before it, and the array is extended after each successful request so a
 * crash can lose at most the one in flight.
 *
 * ## Error is not emptiness
 *
 * Every way production can end badly leaves the item `FAILED` with a sentence
 * naming WHICH beat and WHY — never `PLANNED` (which would look like work that
 * simply has not started) and never `NEEDS_APPROVAL` with a short asset list
 * (which would look like a finished concept that happened to be shorter).
 *
 * One deliberate divergence from `SocialCampaignsService.generateItem`: that
 * path ships a TEXT-ONLY post when media generation is unconfigured, because
 * its media is an illustration. Here the clips ARE the content — a shot plan
 * with no shots is not a shorter video — so an unconfigured generator fails the
 * item by name instead.
 */
@Injectable()
export class ConceptPromotionService implements OnModuleInit {
  private readonly logger = new Logger(ConceptPromotionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaGen: MediaGenService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(
      CONCEPT_PRODUCE_KIND,
      (job: ClaimedJob) =>
        this.produce(job.payload.itemId, job.payload.workspaceId, Number(job.payload.waits ?? 0)),
      // The DLQ hook. `produce` swallows GENERATION errors on purpose, but a DB
      // error anywhere else in it — the opening findFirst, the socialPost.create,
      // the closing update — escapes, and the runner then retries five times and
      // DLQs the job. Without this the item is left at GENERATING with
      // `error: null`, which reads as work that has not started yet while it is
      // in fact holding clips the workspace has already been charged for; and
      // GENERATING is the one status no other surface can act on.
      //
      // `fail()` is best-effort and never throws, which is what the runner wants
      // from a hook it calls while already handling a failure.
      async (job: ClaimedJob, error: string) => {
        await this.fail(
          String(job.payload.itemId),
          `production was abandoned after every retry attempt failed (${error}) — any clips already generated are on this item and were paid for, so regenerating buys the rest, not all of them`,
        );
      },
    );
  }

  /**
   * The concept -> item step. Idempotent; see the class docblock.
   *
   * `socialCampaignId` may be supplied by the caller (the reviewer naming a
   * campaign at approval time) and otherwise comes from the concept, which
   * records it when the idea arrived already scoped. There is no third option:
   * `SocialCampaignItem.socialCampaignId` is a required FK and the campaign is
   * what carries the target accounts, the cadence and the model choice, so
   * inventing one would mean inventing all of those too. An approved concept
   * with nowhere to go is refused BY NAME, and the concept keeps its approval.
   */
  async promote(
    workspaceId: string,
    conceptId: string,
    opts: { socialCampaignId?: string } = {},
  ): Promise<PromoteResult> {
    const concept = await this.prisma.contentConcept.findFirst({
      where: { id: conceptId, workspaceId },
    });
    if (!concept) throw new NotFoundException('Concept not found');
    if (concept.status !== 'APPROVED') {
      throw new BadRequestException(
        `Only an APPROVED concept can be produced; this one is ${concept.status}. Approve it first with jeeta.review_content_concept.`,
      );
    }

    // The cheap repeat: an item is already recorded and still exists.
    if (concept.promotedItemId) {
      const existing = await this.prisma.socialCampaignItem.findFirst({
        where: { id: concept.promotedItemId, workspaceId },
      });
      // If it is GONE (its campaign was deleted, cascading the item away) we
      // fall through and produce again — the work no longer exists, so
      // "already promoted" would be a lie, and the unique index is free again.
      if (existing) {
        // THE RESCUE. An item still at GENERATING is an item whose production
        // never finished: the enqueue crashed, the job was DLQ'd, the process
        // died between the create and the schedule. Nothing else in the product
        // can reach it — `REGENERATABLE_STATES` excludes GENERATING precisely so
        // that a human cannot yank an item out from under a run that is
        // mid-spend — so re-driving the queue here is the only way back.
        //
        // It is free and it cannot double-buy: `schedule` collapses onto the
        // PENDING job under the same dedup key, and `produce()` resumes from
        // `generatedAssetIds`, the clips already paid for.
        if (existing.status === RESCUABLE_ITEM_STATUS) {
          await this.enqueueProduction(workspaceId, existing.id, 0);
        }
        return { item: existing, created: false };
      }
    }

    const campaign = await this.requireCampaign(
      workspaceId,
      opts.socialCampaignId ?? concept.socialCampaignId,
    );

    let item;
    try {
      item = await this.prisma.$transaction(async (tx) => {
        const created = await this.createItemWithin(tx, workspaceId, concept, campaign);
        // Same transaction as the create, so the two links can never disagree:
        // an item with no concept pointing back, or a concept naming an item
        // that was rolled back, are both states this makes impossible.
        await tx.contentConcept.updateMany({
          where: { id: conceptId, workspaceId },
          data: {
            promotedItemId: created.id,
            // The campaign is written back, not merely used. A concept promoted
            // under a campaign the REVIEWER named (rather than one the idea
            // arrived scoped to) otherwise reads as unscoped forever, and the
            // documented "item cascaded away -> promote again" recovery would
            // demand the campaign be named a second time — which no surface
            // does, and which nothing on the row would even tell a caller.
            socialCampaignId: campaign.id,
          },
        });
        return created;
      });
    } catch (e) {
      // Lost the race on `social_campaign_items.contentConceptId`. The winner's
      // row is committed by definition (that is what the violation means), so
      // read it back instead of handing a constraint error to a human.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.socialCampaignItem.findFirst({
          where: { contentConceptId: conceptId, workspaceId },
        });
        if (winner) {
          this.logger.warn(
            `concept ${conceptId} was promoted concurrently; returning item ${winner.id}`,
          );
          return { item: winner, created: false };
        }
      }
      throw e;
    }

    await this.enqueueProduction(workspaceId, item.id, 0);
    return { item, created: true };
  }

  /**
   * Resolve and prove ownership of the campaign a concept will be produced
   * into, BEFORE anything is written. Exposed so `review()` can fail an
   * approval that has nowhere to land while the concept is still PROPOSED —
   * a human can then retry, which an already-decided concept cannot.
   */
  async requireCampaign(workspaceId: string, campaignId: string | null | undefined) {
    if (!campaignId) {
      throw new BadRequestException(
        'This concept is not scoped to a social campaign, so there is no calendar, no target accounts and no model choice to produce it under. Pass socialCampaignId (see jeeta.list_social_campaigns) when approving it.',
      );
    }
    const campaign = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) {
      throw new BadRequestException(
        `Social campaign ${campaignId} does not exist in this workspace, so the concept has nowhere to be produced.`,
      );
    }
    // See PRODUCIBLE_CAMPAIGN_STATUSES: refused BY NAME, and refused HERE —
    // before any verdict is recorded and before a single clip is bought.
    if (!PRODUCIBLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new BadRequestException(
        `Social campaign "${campaign.name}" is ${campaign.status}, and only an ACTIVE or PAUSED campaign can publish what this would produce. ` +
          `Producing into it would generate — and CHARGE FOR — one video clip per beat that the publish gate would then never release. ` +
          `Activate the campaign in the panel first (activation is deliberately a human act, not an agent one), or pass a different socialCampaignId; see jeeta.list_social_campaigns.`,
      );
    }
    return campaign;
  }

  /**
   * The item, created inside the caller's transaction.
   *
   * It starts at `GENERATING`, not `PLANNED`, and that is load-bearing rather
   * than cosmetic. A `PLANNED` item with a non-null `topic` is precisely what
   * `SocialCampaignsService.confirmPlan` sweeps into the GENERIC generator —
   * which would compose its own copy and its own stock image and overwrite this
   * item, discarding the shot plan a human approved. `GENERATING` also matches
   * neither `REGENERATABLE_STATES` nor `REJECTABLE_STATES`, so nothing can
   * yank the item out from under a production run that is mid-spend.
   */
  private async createItemWithin(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    concept: { id: string; hook: string; title: string },
    campaign: {
      id: string;
      cadence: Prisma.JsonValue;
      startDate: Date;
      endDate: Date | null;
    },
  ) {
    const last = await tx.socialCampaignItem.findFirst({
      where: { socialCampaignId: campaign.id },
      orderBy: { scheduledFor: 'desc' },
      select: { scheduledFor: true, sequenceIndex: true },
    });
    const now = new Date();
    const from =
      last?.scheduledFor && last.scheduledFor > now
        ? last.scheduledFor
        : campaign.startDate > now
          ? campaign.startDate
          : now;
    const slot = nextCadenceSlot(campaign.cadence as unknown as Cadence, from);
    const scheduledFor =
      slot && !(campaign.endDate && slot > campaign.endDate)
        ? slot
        : new Date(Date.now() + NO_SLOT_FALLBACK_MS);

    return tx.socialCampaignItem.create({
      data: {
        socialCampaignId: campaign.id,
        workspaceId,
        contentConceptId: concept.id,
        sequenceIndex: (last?.sequenceIndex ?? -1) + 1,
        scheduledFor,
        status: 'GENERATING',
        // The hook is what the item is ABOUT, and it is what the campaign's own
        // planner would have put here. The full creative direction stays on the
        // concept, one id away.
        topic: concept.hook,
      },
    });
  }

  private async enqueueProduction(workspaceId: string, itemId: string, waits: number): Promise<void> {
    await this.scheduledJobs.schedule({
      workspaceId,
      kind: CONCEPT_PRODUCE_KIND,
      runAt: new Date(),
      payload: { itemId, workspaceId, waits },
      // One row per item, forever: a duplicate promote (or a manual re-run)
      // collapses onto the pending job rather than producing the clips twice.
      dedupKey: produceDedup(itemId),
    });
  }

  /**
   * Turn a promoted item's shot plan into clips. The scheduled-job handler.
   *
   * Returns a reschedule directive while the workspace's generation queue is
   * full, and nothing otherwise — the item's own status is the outcome.
   */
  async produce(itemId: string, workspaceId: string, waits = 0): Promise<JobHandlerResult> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: itemId, workspaceId },
      include: { campaign: true },
    });
    if (!item) return;
    // Anything but GENERATING means this run is a duplicate, or a human has
    // already moved the item on. Touching it would re-charge for clips.
    if (item.status !== 'GENERATING' || !item.contentConceptId) return;

    const concept = await this.prisma.contentConcept.findFirst({
      where: { id: item.contentConceptId, workspaceId },
    });
    if (!concept) {
      await this.fail(itemId, 'the content concept this item was promoted from no longer exists');
      return;
    }

    const plan = concept.shotPlan as unknown as ShotPlan | null;
    const shots = Array.isArray(plan?.shots) ? plan.shots : [];
    if (!shots.length) {
      await this.fail(
        itemId,
        'the approved concept carries no shots, so there is nothing to generate — this is a planning failure, not an empty video',
      );
      return;
    }

    const assetIds = [...item.generatedAssetIds];
    // The cursor is what has already been PAID FOR, so a retry never re-buys a
    // clip. It also means a partially produced item is resumable rather than
    // restartable.
    for (let i = assetIds.length; i < shots.length; i++) {
      const shot = shots[i];
      try {
        const { assetId } = await this.mediaGen.requestGeneration(workspaceId, {
          type: 'VIDEO',
          prompt: shot.prompt,
          durationSec: shot.durationSec,
          // The campaign's choice, or the service default. The shot plan's own
          // `model` is a PROMPT-FORMAT label ("seedance"), not a catalogued
          // model id, and handing it over would be refused for unknown pricing.
          ...(item.campaign.defaultVideoModel ? { model: item.campaign.defaultVideoModel } : {}),
          // Both linkage fields. Without socialCampaignId the asset is on
          // `sweepOrphanAssets`' 30-day delete list; without campaignItemId it
          // is off the armed-budget pre-debit path.
          socialCampaignId: item.socialCampaignId,
          campaignItemId: item.id,
          createdById: item.campaign.createdById,
        });
        assetIds.push(assetId);
        // Written per clip, not once at the end: this array IS the resume
        // cursor, so batching it would make a crash lose every clip it paid for.
        await this.prisma.socialCampaignItem.update({
          where: { id: itemId },
          data: { generatedAssetIds: assetIds },
        });
      } catch (e) {
        if (isQueueFull(e)) {
          if (waits >= PRODUCE_MAX_WAITS) {
            await this.fail(
              itemId,
              `the workspace generation queue stayed full for ${Math.round((PRODUCE_MAX_WAITS * PRODUCE_WAIT_MS) / 60000)} minutes, so clip ${i + 1}/${shots.length} was never submitted`,
            );
            return;
          }
          return {
            reschedule: {
              runAt: new Date(Date.now() + PRODUCE_WAIT_MS),
              payload: { itemId, workspaceId, waits: waits + 1 },
            },
          };
        }
        await this.fail(itemId, `clip ${i + 1}/${shots.length} could not be generated: ${reason(e)}`);
        return;
      }
    }

    // Every clip is submitted. Hand the item to the lifecycle it was created
    // for: NEEDS_APPROVAL is the PUBLISH gate, a different decision from the
    // one the human already made about the idea.
    const postId =
      item.socialPostId ??
      (
        await this.prisma.socialPost.create({
          data: {
            workspaceId,
            // The caption the shot planner already wrote. No second AI call:
            // the creative work was done and paid for at planning time.
            content: plan?.captionSuggestion || concept.hook,
            mediaUrls: [],
            status: 'DRAFT',
            socialCampaignId: item.socialCampaignId,
            campaignItemId: item.id,
          },
          select: { id: true },
        })
      ).id;

    await this.prisma.socialCampaignItem.update({
      where: { id: itemId },
      data: { status: 'NEEDS_APPROVAL', socialPostId: postId, generatedAssetIds: assetIds, error: null },
    });
    await this.bumpStats(item.socialCampaignId, { generated: 1 });
  }

  /** FAILED, with the reason ON the row. A caller reading this item must never
   *  have to guess whether it is waiting or broken. */
  private async fail(itemId: string, why: string): Promise<void> {
    this.logger.warn(`concept production failed for item ${itemId}: ${why}`);
    await this.prisma.socialCampaignItem
      .update({ where: { id: itemId }, data: { status: 'FAILED', error: why.slice(0, 500) } })
      .catch(() => undefined);
  }

  /**
   * The same read-merge-write `SocialCampaignsService.bumpStats` does, repeated
   * rather than imported: injecting that service here would pull the entire
   * campaign engine (ContentAi -> Anthropic -> credits -> SocialPlanner) into
   * this module's graph for a four-line JSON merge.
   */
  private async bumpStats(campaignId: string, delta: Record<string, number>): Promise<void> {
    const c = await this.prisma.socialCampaign.findUnique({
      where: { id: campaignId },
      select: { stats: true },
    });
    const stats = { ...((c?.stats as Record<string, number>) ?? {}) };
    for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] ?? 0) + v;
    await this.prisma.socialCampaign
      .update({ where: { id: campaignId }, data: { stats: stats as Prisma.InputJsonValue } })
      .catch(() => undefined);
  }
}
