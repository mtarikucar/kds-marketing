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
import { CampaignItemArmingService } from '../social-campaigns/campaign-item-arming.service';
import { maxPublishableVideos } from '../social-planner/network-adapters';
import {
  DEFAULT_VIDEO_MODEL,
  resolveMediaModelId,
  DEFAULT_VIDEO_REFERENCE_MODEL,
  mediaModelAcceptsReferenceImages,
  mediaModelTakesSeed,
} from '../ai/media/media-models.config';
import {
  type ShotPlan,
  type ShotProduction,
} from '../video/video-pipeline.service';
import { quoteProduction, type VideoModelChoice } from './shot-production';

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

/**
 * The format every post this line produces is published in.
 *
 * Not a choice yet, and stating it as a constant is how that stays honest:
 * nothing on the concept path sets `options.formats`, and `attachAssetsToPost`
 * overwrites `options` wholesale at publish time, so FEED is what the platform
 * actually receives. The destination preview below has to ask its question
 * about the same format the publish will use, or it is describing a post nobody
 * sends — FEED is also the only format on which Instagram carries ten.
 */
export const CONCEPT_PUBLISH_FORMAT = 'FEED' as const;

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

/** How many clips a stored plan will buy. The unit the destination preview
 *  reasons in — one beat is one generation is one video file. */
export function shotCountOf(shotPlan: unknown): number {
  const plan = shotPlan as ShotPlan | null;
  return Array.isArray(plan?.shots) ? plan.shots.length : 0;
}

/** A campaign's target account, as the destination preview needs it. */
export interface DestinationAccount {
  id: string;
  network: string;
  displayName: string | null;
  enabled: boolean;
}

/** What ONE destination does with a concept of N beats. See {@link describeDestination}. */
export interface DestinationPreview {
  accountId: string;
  network: string;
  displayName: string;
  /** Clips this destination will publish. */
  willPublish: number;
  /** Clips this destination cannot take. */
  willDrop: number;
  /** True when this destination publishes nothing at all. */
  publishesNothing: boolean;
  /** One plain sentence, for a human deciding whether to approve. */
  summary: string;
}

/**
 * WHAT THIS DESTINATION RECEIVES, in one sentence — the whole point of not
 * refusing any more.
 *
 * PURE, and it answers with the same table the publish path selects with
 * (`maxPublishableVideos` at {@link CONCEPT_PUBLISH_FORMAT}), so the preview
 * and the publish cannot disagree: "Instagram: all 5 clips as a carousel ·
 * TikTok: beat 1 only · X: nothing, it cannot carry video".
 *
 * A DISCONNECTED account gets its own sentence rather than a capacity one. The
 * network could carry the clips; the account cannot receive them, and telling a
 * reviewer "5 clips as a carousel" about an account `attachTargets` will skip
 * would be a worse lie than the silence this replaces.
 */
export function describeDestination(
  account: DestinationAccount,
  shotCount: number,
): DestinationPreview {
  const name = account.displayName || account.network;
  const base = { accountId: account.id, network: account.network, displayName: name };
  const beats = Math.max(0, shotCount);

  if (!account.enabled) {
    return {
      ...base,
      willPublish: 0,
      willDrop: beats,
      publishesNothing: true,
      summary: `${name} (${account.network}): nothing — this account is disconnected, so the post will not reach it. Reconnect it or drop it from the campaign's targets.`,
    };
  }

  const cap = maxPublishableVideos(account.network, CONCEPT_PUBLISH_FORMAT);
  const willPublish = Math.min(cap, beats);
  const willDrop = beats - willPublish;

  if (willPublish === 0) {
    return {
      ...base,
      willPublish: 0,
      willDrop,
      publishesNothing: true,
      summary: `${name} (${account.network}): nothing — ${account.network} cannot carry video, so this post will not be published there at all.`,
    };
  }
  if (willDrop === 0) {
    const how = beats > 1 ? `all ${beats} clips, as a carousel` : 'the single clip';
    return { ...base, willPublish, willDrop, publishesNothing: false, summary: `${name} (${account.network}): ${how}.` };
  }
  const which = willPublish === 1 ? 'beat 1 only' : `beats 1-${willPublish} only`;
  return {
    ...base,
    willPublish,
    willDrop,
    publishesNothing: false,
    summary: `${name} (${account.network}): ${which} — ${account.network} carries ${cap} video${cap === 1 ? '' : 's'} per post, so ${willDrop} of the ${beats} clips will not be published there.`,
  };
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
    private readonly arming: CampaignItemArmingService,
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

    // NO PLAN, AND THEREFORE NO QUOTE CHECK — this side of the verdict.
    //
    // `assertQuoteHolds` refuses a campaign whose model is not the one the
    // reviewer was quoted, and its whole safety rests on being asked BEFORE the
    // verdict: `review()` calls `requireCampaign` with the plan while the
    // concept is still PROPOSED, so a refusal leaves every remedy open.
    //
    // Here the verdict is already written. `promote()` runs AFTER approval, and
    // it is also the documented recovery for an APPROVED concept whose item was
    // never created (a crash in `review()`'s window) or was cascaded away with
    // its campaign — the state `ContentConceptsService.produce` exists to close
    // and the only route out of it. Asking the quote question here refuses that
    // recovery the moment somebody changes the campaign's `defaultVideoModel`
    // (or the workspace default moves) between the approval and the rescue: the
    // concept cannot be decided again, `promote` throws every time, and the
    // approved work is stranded permanently — which is exactly what this file
    // says about the aspect check it moved OUT of `produce` for the same reason.
    //
    // The pre-verdict door keeps the guarantee; a second copy of it downstream
    // could only take remedies away.
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
  async requireCampaign(
    workspaceId: string,
    campaignId: string | null | undefined,
    opts: {
      /** The concept's own plan, when there is one. Carries the QUOTE the
       *  reviewer is about to approve. */
      plan?: ShotPlan | null;
    } = {},
  ) {
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
    // NOTE: there is deliberately no destination-capacity refusal here any more.
    // `assertDestinationsCanCarry` used to refuse the whole approval unless
    // EVERY targeted account could publish EVERY beat, which — measured against
    // the real network table — refused seven of the eight networks and left the
    // feature working on all-Instagram campaigns only. Capacity is now settled
    // per target at publish (`selectMediaForTarget`), and what each destination
    // will actually receive is shown to the reviewer BEFORE they approve
    // (`describeDestinations`), which is the honest replacement for a refusal.
    await this.assertQuoteHolds(workspaceId, campaign, opts.plan);
    return campaign;
  }

  /**
   * THE PRICE THE REVIEWER SAW IS THE PRICE THAT WILL BE PAID.
   *
   * A plan carries the quote it was made under — the endpoint, the billed
   * seconds, the credits, the dollars (see {@link ShotProduction}). That quote
   * was computed against a specific model, resolved from the campaign the
   * concept was planned for (or, unscoped, from the workspace default). A
   * reviewer may approve it into a DIFFERENT campaign, and a campaign carries
   * its own `defaultVideoModel` — 3 credits per second on the platform default,
   * 48 on Seedance 2.5. Producing under a model nobody was quoted for is the
   * same defect as the persona substitution this quote exists to end, arriving
   * through the other door.
   *
   * So it is refused, and refused HERE: `review()` calls this before the verdict
   * is recorded, so the concept stays PROPOSED and every remedy is still open —
   * approve it into the campaign it was planned for, re-plan it under this one
   * (the quote is then the one on screen), or clear the campaign's override. A
   * refusal after the verdict would be a stranded approval, which is exactly
   * what the aspect check used to do from inside `produce`.
   *
   * Silence for a plan with no quote: those predate the record, nobody was
   * quoted anything, and there is no promise to keep.
   */
  private async assertQuoteHolds(
    workspaceId: string,
    campaign: { name: string; defaultVideoModel: string | null },
    plan: ShotPlan | null | undefined,
  ): Promise<void> {
    const quoted = plan?.production;
    if (!quoted) return;

    const wantsReference = (plan?.shots ?? []).some((sh) => (sh.reference?.images?.length ?? 0) > 0);
    const choice = await this.resolveVideoModel(
      workspaceId,
      campaign.defaultVideoModel,
      wantsReference,
    );
    if (choice.model === quoted.model) return;

    const now = quoteProduction(plan as ShotPlan, choice);
    // Name WHERE the other model comes from: "the campaign chose it" and "the
    // workspace default changed under it" are different mistakes with different
    // fixes, and a message that says "campaign" about a workspace setting sends
    // the reader to the wrong screen.
    const source =
      choice.modelSource === 'campaign'
        ? `Campaign "${campaign.name}" runs ${choice.model}`
        : `This workspace now produces on ${choice.model}`;
    throw new BadRequestException(
      `This concept was planned and quoted on ${quoted.model}: ${quoted.credits} credits ` +
        `($${quoted.usd.toFixed(2)}) for ${quoted.billedSecPerBeat.length} clips. ` +
        `${source}, which would cost ${now.credits} credits ($${now.usd.toFixed(2)}) instead — ` +
        `a price nobody approved. Approve it into the campaign it was planned for, or re-plan the ` +
        `concept as it will actually be produced (jeeta.plan_content_concepts with socialCampaignId) ` +
        `so the quote you approve is the one that is charged.`,
    );
  }

  /**
   * WHAT EACH DESTINATION WILL ACTUALLY RECEIVE — told to the reviewer BEFORE
   * they approve.
   *
   * This is the honest replacement for the refusal that used to live here, and
   * the reason deleting that refusal is safe. Nothing is refused over capacity
   * any more: the same five-beat concept is a five-clip carousel on Instagram,
   * beat 1 alone on TikTok, and nothing at all on X — three different truths
   * about one approval, and a reviewer is entitled to all three before they
   * spend the money rather than after.
   *
   * The read is deliberately NOT filtered by `enabled`. The old check read
   * `enabled: true` accounts only, so a disconnected account was invisible at
   * approval and could still be attached at publish; here a disconnected target
   * is shown, saying it will receive nothing, which is what will happen
   * (`attachTargets` skips it).
   *
   * `campaignIds` rather than one id because the review queue lists many
   * concepts at once and they share a handful of campaigns: two reads for the
   * whole page instead of two per row.
   */
  async destinationAccounts(
    workspaceId: string,
    campaignIds: string[],
  ): Promise<Map<string, DestinationAccount[]>> {
    const wanted = [...new Set(campaignIds.filter(Boolean))];
    const byCampaign = new Map<string, DestinationAccount[]>();
    if (!wanted.length) return byCampaign;

    const campaigns = await this.prisma.socialCampaign.findMany({
      where: { id: { in: wanted }, workspaceId },
      select: { id: true, targetAccountIds: true },
    });
    const accountIds = [...new Set(campaigns.flatMap((c) => c.targetAccountIds ?? []))];
    // A campaign id that is a typo, a neighbour's, or since deleted resolves to
    // no campaign and therefore to no destinations — never to another
    // workspace's accounts: both reads carry `workspaceId`.
    const accounts = accountIds.length
      ? await this.prisma.socialAccount.findMany({
          where: { id: { in: accountIds }, workspaceId },
          select: { id: true, network: true, displayName: true, enabled: true },
        })
      : [];
    const byId = new Map(accounts.map((a) => [a.id, a as DestinationAccount]));

    for (const c of campaigns) {
      byCampaign.set(
        c.id,
        (c.targetAccountIds ?? []).map((id) => byId.get(id)).filter((a): a is DestinationAccount => !!a),
      );
    }
    return byCampaign;
  }

  /**
   * The per-destination sentences for ONE concept, ready to show a reviewer.
   *
   * `shotCount` is the plan's beat count — one beat is one clip is one video
   * file, which is the unit every network limit in `maxPublishableVideos` is
   * expressed in.
   */
  async describeDestinations(
    workspaceId: string,
    campaignId: string | null | undefined,
    shotCount: number,
  ): Promise<DestinationPreview[]> {
    if (!campaignId) return [];
    const byCampaign = await this.destinationAccounts(workspaceId, [campaignId]);
    return (byCampaign.get(campaignId) ?? []).map((a) => describeDestination(a, shotCount));
  }

  /**
   * WHICH ENDPOINT WILL RUN, and why — one implementation, used by the planner
   * (to quote before a human approves) and by the producer (for a plan made
   * before quotes existed).
   *
   * The order is the product's, stated once in
   * `MediaGenService.workspaceDefaultModel`: campaign override ?? workspace
   * default ?? platform constant.
   *
   * THE PERSONA OVERRIDE IS THE EXPENSIVE ONE. `VIDEO_REFERENCE` is a different
   * TECHNIQUE, not a styling preference: it is the only contract that takes an
   * ARRAY of reference frames, which is what holds one face or one product
   * identical across every beat. A campaign's `defaultVideoModel` names a
   * text-to-video endpoint, and `buildFalInput` maps sources by CONTRACT — so
   * nine reference frames sent there reach the wire as none at all. Substituting
   * the reference model is therefore right; doing it silently was not. It is 48
   * credits per second against the platform default's 3, with a 4-second floor
   * under beats approved at 3, and deciding it HERE means the substitution and
   * its price land on the plan a human reads, instead of in a log line written
   * after they approved something else.
   */
  async resolveVideoModel(
    workspaceId: string,
    campaignVideoModel: string | null | undefined,
    wantsReference: boolean,
  ): Promise<VideoModelChoice> {
    const chosen = campaignVideoModel ?? null;
    const model = chosen ?? (await this.mediaGen.workspaceDefaultModel(workspaceId, 'VIDEO'));
    // 'platform' vs 'workspace' is decided by comparing with the constant: a
    // workspace that explicitly chose the platform default is reported as
    // 'platform', which is true of what will run and is the only part of this
    // anyone spends money on.
    const modelSource: VideoModelChoice['modelSource'] = chosen
      ? 'campaign'
      : resolveMediaModelId(model) === DEFAULT_VIDEO_MODEL
        ? 'platform'
        : 'workspace';

    if (wantsReference && !mediaModelAcceptsReferenceImages(model)) {
      return {
        model: DEFAULT_VIDEO_REFERENCE_MODEL,
        modelSource: 'persona',
        replacedModel: model,
      };
    }
    return { model, modelSource };
  }

  /**
   * Write the production record onto a plan that predates it.
   *
   * Best-effort by construction: the clips are about to be bought either way,
   * and a failed write here must not fail an approved item. What it buys is that
   * the plan a human opens afterwards says what was actually purchased — the
   * endpoint, the frame, the seconds, the price — instead of staying silent the
   * way every plan did before the record existed.
   */
  private async recordProduction(
    workspaceId: string,
    conceptId: string,
    plan: ShotPlan,
    production: ShotProduction,
  ): Promise<void> {
    await this.prisma.contentConcept
      .updateMany({
        where: { id: conceptId, workspaceId },
        data: { shotPlan: { ...plan, production } as unknown as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
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

    // WHAT THIS PLAN BUYS — read off the plan, not re-decided here.
    //
    // `ShotPlan.production` is written when the plan is MADE (see
    // `shot-production.ts`): the catalogued endpoint that will run, the frame it
    // will be asked for, the seconds each beat will be billed at, and the quote
    // in credits and dollars. A human approved THAT. Re-deriving any of it here
    // would mean the thing bought is decided after the approval, which is the
    // defect this record exists to close — a persona plan silently swapped the
    // model for one at 16x the rate, and the plan still said otherwise.
    //
    // A plan persisted before the record existed gets one now, resolved the same
    // way and WRITTEN BACK onto the concept, so no plan stays silent about what
    // it bought.
    let production = plan?.production;
    if (!production) {
      const choice = await this.resolveVideoModel(
        workspaceId,
        item.campaign.defaultVideoModel,
        shots.some((sh) => (sh.reference?.images?.length ?? 0) > 0),
      );
      production = quoteProduction(plan as ShotPlan, choice);
      await this.recordProduction(workspaceId, item.contentConceptId, plan as ShotPlan, production);
    }

    const model = production.model;
    // NULL means the endpoint takes no ratio, or takes an enum this frame is not
    // in. Either way the clip is framed by the model and `production.frameNote`
    // says so on the plan — it is NOT a reason to fail an item a human already
    // approved. That refusal now lives at the door where the model is chosen
    // (`assertModelOffersAspect`, called by campaign create/update and by the
    // workspace defaults card), where a person is present to act on it; here it
    // could only strand approved work, because `review()` refuses a second
    // verdict and `regenerateItem` refuses a promoted item.
    const aspectRatio = production.aspectRatio ?? undefined;
    if (production.frameNote) {
      this.logger.log(`item ${itemId}: ${production.frameNote}`);
    }
    const seedable = mediaModelTakesSeed(model);

    const assetIds = [...item.generatedAssetIds];
    // The cursor is what has already been PAID FOR, so a retry never re-buys a
    // clip. It also means a partially produced item is resumable rather than
    // restartable.
    for (let i = assetIds.length; i < shots.length; i++) {
      const shot = shots[i];
      const refs = shot.reference?.images ?? [];
      try {
        const { assetId } = await this.mediaGen.requestGeneration(workspaceId, {
          type: 'VIDEO',
          prompt: shot.prompt,
          // The BILLED length from the quote, not the raw beat: a model with a
          // 4-second floor renders and charges 4 for a 3-second beat, and the
          // approved plan already says 4 because the quote put it there.
          durationSec: production.billedSecPerBeat[i] ?? shot.durationSec,
          // THE PARAMETER that decides the frame - the same value the prompt
          // text was built from, so the words and the wire cannot disagree.
          // Omitted entirely for a model that takes none.
          ...(aspectRatio ? { aspectRatio } : {}),
          // From the plan's own production record. The shot plan's `model` field
          // is a PROMPT-FORMAT label ("seedance"), not a catalogued model id,
          // and handing it over would be refused for unknown pricing.
          model,
          // The identity lock, finally leaving the plan. `PersonaLock` puts the
          // persona's reference frames on EVERY shot precisely so one face or
          // one product is the same object in all of them; they were persisted
          // on the shot and then never sent, which is why five clips from one
          // concept looked like five unrelated videos.
          ...(refs.length ? { referenceImageUrls: refs } : {}),
          // Only where the endpoint takes one as INPUT. Seedance 2.5's
          // text-to-video RETURNS a seed and accepts none; its reference-to-video
          // sibling accepts one, and there a locked seed is a real second lever
          // on identity rather than an unsupported parameter.
          ...(seedable && shot.reference?.seed != null ? { seed: shot.reference.seed } : {}),
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
    // for.
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

    // The campaign's OWN autonomy setting decides what happens next, through the
    // same service the generic generator uses.
    //
    // This used to write `NEEDS_APPROVAL` unconditionally and schedule nothing,
    // ignoring `automationMode` entirely - so a workspace that chose FULL_AUTO
    // got a SECOND human gate on every concept, and its items sat in the
    // approval queue forever with only `approveItem` able to arm the publish.
    // That is the precise opposite of what this file says about itself: the
    // human decision stays exactly where the owner put it, ONCE, on the concept.
    //
    // Reusing `CampaignItemArmingService` rather than repeating the branch is
    // deliberate: this is an autonomy rule about money and publishing, and two
    // copies is where the strict one and the loose one drift apart. Nothing is
    // loosened by sharing it - arming schedules the same `confirmItem` gate,
    // with the same dedup key, at the same slot, and every guard that gate
    // enforces (campaign ACTIVE, media READY, dailyPublishCap, brand safety)
    // applies to an item that arrived this way exactly as it does to one a human
    // approved.
    await this.arming.arm({
      workspaceId,
      itemId,
      automationMode: item.campaign.automationMode,
      scheduledFor: item.scheduledFor,
      data: { socialPostId: postId, generatedAssetIds: assetIds, error: null },
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
