import {
  BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, SocialCampaignItemStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService, ClaimedJob, JobHandlerResult,
} from '../scheduling/scheduled-job-runner.service';
import { ContentAiService } from '../ai/content-ai.service';
import { BrandSafetyService } from '../ai/brand-safety.service';
import { MediaGenService } from '../ai/media/media-gen.service'; // Milestone 1
import { SocialPlannerService } from '../social-planner/social-planner.service';
import { assertCataloguedModel, assertModelOffersAspect } from '../ai/media/media-models.config';
import { DEFAULT_SHOT_ASPECT } from '../video/video-pipeline.service';
import { VideoAssemblyService } from '../ai/media/video-assembly.service';
import { R2StorageService } from '../../../common/storage/r2-storage.service';
import { readFile, unlink } from 'node:fs/promises';
import { Cadence, nextCadenceSlot } from './cadence.util';
import {
  CampaignItemArmingService,
  SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
  confirmDedup,
} from './campaign-item-arming.service';
import {
  CONCEPT_PRODUCE_KIND,
  produceDedup,
} from '../content-concepts/concept-promotion.service';

export const SOCIAL_CAMPAIGN_PLAN_KIND = 'social.campaign.plan';
export const SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND = 'social.campaign.item.generate';

export const planDedup = (id: string) => `social-campaign-plan-${id}`;
export const generateDedup = (id: string) => `social-campaign-generate-${id}`;

// The confirm gate's job kind and dedup key now live beside the ONE service
// that arms it (`campaign-item-arming.service.ts`), so the concept producer can
// reuse the arming without importing this file — which imports it back for
// CONCEPT_PRODUCE_KIND, and a cycle between two service modules is how a
// `const` ends up `undefined` at module-init time. Re-exported here because
// this is the name every existing caller already imports.
export { SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, confirmDedup };

// Item states from which the confirm gate may publish. SCHEDULED = auto/approved;
// NEEDS_APPROVAL is publishable only for SEMI_AUTO (auto-publish-unless-rejected).
const REGENERATABLE_STATES = ['PLANNED', 'NEEDS_APPROVAL', 'FAILED', 'SKIPPED'];
const REJECTABLE_STATES = ['PLANNED', 'NEEDS_APPROVAL', 'SCHEDULED'];
// Confirm gate waits this long (from scheduledFor) for still-generating media
// before giving up, retrying every MEDIA_READY_RETRY_MS.
const MEDIA_READY_MAX_WAIT_MS = Number(process.env.SOCIAL_CAMPAIGN_MEDIA_WAIT_MS ?? 30 * 60 * 1000);
const MEDIA_READY_RETRY_MS = Number(process.env.SOCIAL_CAMPAIGN_MEDIA_RETRY_MS ?? 2 * 60 * 1000);

/** Whether a generated asset can actually be put on a post, and how to SAY what
 *  it is when it cannot. READY with no stored file is not a publishable asset —
 *  it is a row that finished with nothing behind it — and describing it as
 *  "READY" in a message about why nothing was sent would read as a lie. */
const isAttachable = (a: { status: string; url: string | null }) => a.status === 'READY' && !!a.url;
const describeAsset = (a: { status: string; url: string | null }) =>
  a.status === 'READY' && !a.url ? 'READY but no file' : a.status;

export interface CreateSocialCampaignInput {
  name: string;
  goal?: string;
  theme?: string;
  brief: Record<string, unknown>;
  automationMode: 'APPROVAL' | 'SEMI_AUTO' | 'FULL_AUTO';
  planningMode: 'AI_PROPOSE' | 'AI_FULL' | 'USER_TOPICS';
  cadence: Cadence;
  startDate: Date;
  endDate?: Date;
  targetAccountIds: string[];
  mediaKinds: string[];
  defaultImageModel?: string;
  defaultVideoModel?: string;
  dailyPublishCap?: number;
  linkedCampaignId?: string;
  /** Set by the Growth Autopilot engine (= the GrowthBudget id) for idempotent provisioning. */
  engineBudgetId?: string;
  createdById: string;
}

/** How many calendar slots ride along with each campaign in `list`. */
export const CAMPAIGN_ITEM_PREVIEW = 20;

@Injectable()
export class SocialCampaignsService implements OnModuleInit {
  private readonly logger = new Logger(SocialCampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly contentAi: ContentAiService,
    private readonly planner: SocialPlannerService,
    private readonly brandSafety: BrandSafetyService,
    private readonly mediaGen: MediaGenService,
    private readonly arming: CampaignItemArmingService,
    // Appended, not inserted: the specs for this service construct it
    // positionally, and a dependency added mid-list shifts every one of them
    // onto the wrong argument without a single test going red.
    private readonly assembly: VideoAssemblyService,
    private readonly r2: R2StorageService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(SOCIAL_CAMPAIGN_PLAN_KIND, (job: ClaimedJob) =>
      this.planTick(job.payload.campaignId, job.payload.workspaceId));
    this.runner.registerHandler(SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, (job: ClaimedJob) =>
      this.generateItem(job.payload.itemId, job.payload.workspaceId));
    this.runner.registerHandler(SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, (job: ClaimedJob) =>
      this.confirmItem(job.payload.itemId, job.payload.workspaceId));
  }

  // ───────────────────────────────────────────────────────────── CRUD

  /**
   * The campaign's model override, checked WHERE IT IS CHOSEN.
   *
   * `defaultImageModel` / `defaultVideoModel` are the FIRST term of
   * `campaign override ?? workspace default ?? code constant`, and until this
   * check the columns took any string. Two failures came out of that, and
   * neither of them looked like a bad model id:
   *
   *  - an id catalogued as the WRONG KIND (`fal-ai/qwen-image` as the video
   *    model — one row away in a picker that lists both) passed here and was
   *    then refused by `MediaGenService` with `MEDIA_GEN_UNKNOWN_MODEL` at
   *    generation time, which is hours later, on the scheduled-job path, once
   *    per item, with the reason on an item row instead of on the screen where
   *    the choice was made;
   *  - a typo'd id did the same, and `ConceptPromotionService.produce` turns
   *    that into "clip 1/5 could not be generated" on a FAILED item, for a
   *    campaign that will fail every item it ever plans.
   *
   * Same function and same sentence the workspace-level card uses, so the two
   * doors onto one decision cannot drift.
   */
  private assertModels(input: {
    defaultImageModel?: string | null;
    defaultVideoModel?: string | null;
  }): void {
    if (input.defaultImageModel) assertCataloguedModel(input.defaultImageModel, 'IMAGE');
    if (input.defaultVideoModel) {
      assertCataloguedModel(input.defaultVideoModel, 'VIDEO');
      // And it must be able to shoot the frame this content line plans in.
      //
      // This question used to be asked in `ConceptPromotionService.produce` —
      // after a human had approved the concept, after the item existed, and with
      // no way back: an approved concept cannot be re-decided and a promoted
      // item cannot be regenerated, so a campaign pointed at a model that does
      // not publish 9:16 failed every concept it was ever given, permanently.
      // Asked here it is one sentence on the screen where the model is being
      // chosen, before anything is planned or bought. A model that publishes NO
      // ratio at all is fine and is deliberately allowed — see
      // `assertModelOffersAspect`.
      assertModelOffersAspect(input.defaultVideoModel, DEFAULT_SHOT_ASPECT);
    }
  }

  async create(workspaceId: string, input: CreateSocialCampaignInput) {
    this.assertModels(input);
    return this.prisma.socialCampaign.create({
      data: {
        workspaceId,
        name: input.name,
        goal: input.goal ?? null,
        theme: input.theme ?? null,
        brief: input.brief as Prisma.InputJsonValue,
        automationMode: input.automationMode,
        planningMode: input.planningMode,
        cadence: input.cadence as unknown as Prisma.InputJsonValue,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        targetAccountIds: input.targetAccountIds,
        mediaKinds: input.mediaKinds,
        defaultImageModel: input.defaultImageModel ?? null,
        defaultVideoModel: input.defaultVideoModel ?? null,
        dailyPublishCap: input.dailyPublishCap ?? 2,
        linkedCampaignId: input.linkedCampaignId ?? null,
        engineBudgetId: input.engineBudgetId ?? null,
        createdById: input.createdById,
        status: 'DRAFT',
      },
    });
  }

  /**
   * The campaigns, each carrying its most recent calendar slots.
   *
   * The items came with it on 2026-09-01 and the reason is a discoverability
   * one, not a convenience one: `jeeta.plan_content_distribution` REQUIRES a
   * `campaignItemId`, and until this include there was no tool anywhere in the
   * catalogue that returned one. `jeeta.list_content_concepts` supplies
   * `promotedItemId` for items that came from a concept, but a cadence-planned
   * item had no source at all — which is the exact shape of the three bugs
   * `tool-catalogue.spec.ts`'s undiscoverable-prerequisite tripwire was written
   * to catch (an operation that is not awkward but impossible).
   *
   * Bounded by {@link CAMPAIGN_ITEM_PREVIEW} rather than unbounded: a
   * long-running campaign accumulates hundreds of slots, and putting all of
   * them in a list response would put them in every MCP session's context too.
   */
  list(workspaceId: string) {
    return this.prisma.socialCampaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          orderBy: { scheduledFor: 'desc' },
          take: CAMPAIGN_ITEM_PREVIEW,
          select: {
            id: true,
            status: true,
            scheduledFor: true,
            sequenceIndex: true,
            topic: true,
            contentConceptId: true,
            socialPostId: true,
          },
        },
      },
    });
  }

  async get(workspaceId: string, id: string) {
    return this.getOwned(workspaceId, id);
  }

  async update(workspaceId: string, id: string, patch: Partial<CreateSocialCampaignInput>) {
    this.assertModels(patch);
    const c = await this.getOwned(workspaceId, id);

    // A "mode-only" patch touches ONLY automationMode and/or planningMode. Those
    // are safe to retune after activation (they change how FUTURE items are
    // handled); every other field still requires a DRAFT campaign so an in-flight
    // schedule/cadence/target set can't shift under a running campaign.
    const MODE_FIELDS = ['automationMode', 'planningMode'];
    const touched = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    const modeOnly = touched.length > 0 && touched.every((k) => MODE_FIELDS.includes(k));

    if (modeOnly) {
      if (['COMPLETED', 'CANCELLED'].includes(c.status)) {
        throw new BadRequestException('Cannot change modes of a completed/cancelled campaign');
      }
      // ACTIVE | PAUSED | DRAFT are all fine to retune — but never mid-generation:
      // an item claimed PLANNED→GENERATING has already picked its automation branch,
      // so flipping modes now would desync it. Make the user pause first.
      if (c.status === 'ACTIVE') {
        const generating = await this.prisma.socialCampaignItem.count({
          where: { socialCampaignId: id, status: SocialCampaignItemStatus.GENERATING },
        });
        if (generating > 0) {
          throw new BadRequestException('A post is mid-generation — pause the campaign before changing modes');
        }
      }
    } else if (c.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT campaigns can be edited');
    }

    return this.prisma.socialCampaign.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief as Prisma.InputJsonValue } : {}),
        ...(patch.automationMode !== undefined ? { automationMode: patch.automationMode } : {}),
        ...(patch.planningMode !== undefined ? { planningMode: patch.planningMode } : {}),
        ...(patch.cadence !== undefined ? { cadence: patch.cadence as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
        ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
        ...(patch.targetAccountIds !== undefined ? { targetAccountIds: patch.targetAccountIds } : {}),
        ...(patch.mediaKinds !== undefined ? { mediaKinds: patch.mediaKinds } : {}),
        ...(patch.defaultImageModel !== undefined ? { defaultImageModel: patch.defaultImageModel } : {}),
        ...(patch.defaultVideoModel !== undefined ? { defaultVideoModel: patch.defaultVideoModel } : {}),
        ...(patch.dailyPublishCap !== undefined ? { dailyPublishCap: patch.dailyPublishCap } : {}),
        ...(patch.linkedCampaignId !== undefined ? { linkedCampaignId: patch.linkedCampaignId } : {}),
      },
    });
  }

  /**
   * List a campaign's items ENRICHED with their generated content, so the
   * content-calendar UI can show the real post (caption + media thumbnail),
   * not just a bare topic + status. Batched (one query for posts, one for
   * assets — no N+1) and workspace-scoped. `caption` comes from the linked
   * SocialPost; `media` from the GeneratedAsset rows (carrying their own
   * status so the UI can show a spinner while a slot is still GENERATING).
   */
  async listItems(workspaceId: string, campaignId: string) {
    const items = await this.prisma.socialCampaignItem.findMany({
      where: { workspaceId, socialCampaignId: campaignId },
      orderBy: { sequenceIndex: 'asc' },
    });
    const postIds = [...new Set(items.map((i) => i.socialPostId).filter((x): x is string => !!x))];
    const assetIds = [...new Set(items.flatMap((i) => i.generatedAssetIds ?? []))];
    const [posts, assets] = await Promise.all([
      postIds.length
        ? this.prisma.socialPost.findMany({
            where: { id: { in: postIds }, workspaceId },
            select: { id: true, content: true, mediaUrls: true, publishedAt: true },
          })
        : Promise.resolve([]),
      assetIds.length
        ? this.prisma.generatedAsset.findMany({
            where: { id: { in: assetIds }, workspaceId },
            select: { id: true, type: true, status: true, url: true, thumbnailUrl: true, mime: true },
          })
        : Promise.resolve([]),
    ]);
    const postById = new Map(posts.map((p) => [p.id, p]));
    const assetById = new Map(assets.map((a) => [a.id, a]));
    return items.map((i) => {
      const post = i.socialPostId ? postById.get(i.socialPostId) : undefined;
      return {
        ...i,
        caption: post?.content ?? null,
        publishedAt: post?.publishedAt ?? null,
        media: (i.generatedAssetIds ?? [])
          .map((id) => assetById.get(id))
          .filter((a): a is NonNullable<typeof a> => !!a)
          .map((a) => ({ id: a.id, type: a.type, status: a.status, url: a.url, thumbnailUrl: a.thumbnailUrl, mime: a.mime })),
      };
    });
  }

  // ──────────────────────────────────────────────────────── Lifecycle

  async activate(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (!['DRAFT', 'PAUSED'].includes(c.status)) {
      throw new BadRequestException(`Cannot activate from ${c.status}`);
    }
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.enqueuePlan(workspaceId, id);
    return this.get(workspaceId, id);
  }

  async resume(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (c.status !== 'PAUSED') throw new BadRequestException(`Cannot resume from ${c.status}`);
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.enqueuePlan(workspaceId, id);
    return this.get(workspaceId, id);
  }

  async pause(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (c.status !== 'ACTIVE') throw new BadRequestException(`Cannot pause from ${c.status}`);
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'PAUSED' } });
    await this.scheduledJobs.cancel(SOCIAL_CAMPAIGN_PLAN_KIND, planDedup(id));
    return this.get(workspaceId, id);
  }

  async cancel(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (['COMPLETED', 'CANCELLED'].includes(c.status)) {
      throw new BadRequestException(`Cannot cancel from ${c.status}`);
    }
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.scheduledJobs.cancel(SOCIAL_CAMPAIGN_PLAN_KIND, planDedup(id));
    return this.get(workspaceId, id);
  }

  /** AI_PROPOSE: user confirms the proposed plan → fan out generation. */
  async confirmPlan(workspaceId: string, campaignId: string): Promise<{ confirmed: number }> {
    const c = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId }, select: { id: true, planningMode: true },
    });
    if (!c) throw new NotFoundException('Social campaign not found');
    const items = await this.prisma.socialCampaignItem.findMany({
      where: { workspaceId, socialCampaignId: campaignId, status: 'PLANNED', topic: { not: null } },
      select: { id: true },
    });
    for (const it of items) {
      await this.scheduledJobs.schedule({
        workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, runAt: new Date(),
        payload: { itemId: it.id, workspaceId }, dedupKey: generateDedup(it.id),
      });
    }
    return { confirmed: items.length };
  }

  // ──────────────────────────────────────────── Approval-queue actions

  async approveItem(workspaceId: string, itemId: string) {
    const item = await this.getOwnedItem(workspaceId, itemId);
    if (item.status !== 'NEEDS_APPROVAL') {
      throw new BadRequestException(`Cannot approve an item in status ${item.status}`);
    }
    // Approval makes the item publishable: SCHEDULED, and the same confirm gate
    // the auto modes arm (which attaches media, runs brand-safety, honors
    // dailyPublishCap, then publishes via the social-planner path).
    //
    // Through the SAME service the two producers use, not a third copy of
    // status + schedule + dedup. The copy that used to live here was not merely
    // duplication: arming is what starts the media-ready window (`armedAt`), and
    // a door that arms without stamping it is a door that publishes a caption
    // with no video.
    return this.arming.armApproved({ workspaceId, itemId, scheduledFor: item.scheduledFor });
  }

  async rejectItem(workspaceId: string, itemId: string) {
    const item = await this.getOwnedItem(workspaceId, itemId);
    // Only pending items can be vetoed — never a PUBLISHED (already-live) item.
    if (!REJECTABLE_STATES.includes(item.status)) {
      throw new BadRequestException(`Cannot reject an item in status ${item.status}`);
    }
    return this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'SKIPPED' } });
  }

  async regenerateItem(workspaceId: string, itemId: string) {
    const item = await this.getOwnedItem(workspaceId, itemId);
    // Guard the source state (mirrors approveItem): regenerating a PUBLISHED or
    // in-flight (SCHEDULED/GENERATING) item would re-charge AI+media credits and
    // re-publish the slot with a fresh, un-deduped post.
    if (!REGENERATABLE_STATES.includes(item.status)) {
      throw new BadRequestException(`Cannot regenerate an item in status ${item.status}`);
    }
    // A PROMOTED item (one that came from an approved ContentConcept) has to go
    // back through the CONCEPT producer, not this one. The generic path composes
    // fresh copy and a stock image, which for this item would overwrite the shot
    // plan a human approved — and the shot plan IS the content here, not an
    // illustration of it. Resetting it to PLANNED would be worse still: a
    // PLANNED item with a topic is exactly what confirmPlan sweeps into that
    // same generic generator.
    if (item.contentConceptId) {
      // Whether the paid-for cursor (`generatedAssetIds`) survives is decided by
      // the SOURCE STATE, because that is what distinguishes two different
      // requests wearing one button.
      //
      // FAILED = production stopped part-way through a spend. The concept's shot
      // plan is immutable (nothing in the product edits it), so beats already
      // bought are byte-for-byte the beats a rebuild would buy again. Keeping the
      // cursor is therefore never worse than clearing it — same output, and at
      // worst the same cost, since an item that failed on beat 1 has an empty
      // cursor and resume IS rebuild. Clearing it meant an item that died on
      // beat 3 of 5 for a transient provider blip re-bought beats 1-2 for
      // nothing, on the most expensive action in the product.
      //
      // Anything else (NEEDS_APPROVAL above all) = a human has SEEN the finished
      // clips and is asking for DIFFERENT ones. There the cursor must go, or
      // "regenerate" hands back the same video.
      const resume = item.status === 'FAILED';
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId },
        data: {
          status: 'GENERATING',
          error: null,
          socialPostId: null,
          ...(resume ? {} : { generatedAssetIds: [] }),
        },
      });
      await this.scheduledJobs.schedule({
        workspaceId, kind: CONCEPT_PRODUCE_KIND, runAt: new Date(),
        payload: { itemId, workspaceId, waits: 0 }, dedupKey: produceDedup(itemId),
      });
      return item;
    }

    // Reset to PLANNED so generateItem's atomic PLANNED→GENERATING claim matches.
    await this.prisma.socialCampaignItem.update({
      where: { id: itemId }, data: { status: 'PLANNED', error: null },
    });
    await this.scheduledJobs.schedule({
      workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, runAt: new Date(),
      payload: { itemId, workspaceId }, dedupKey: generateDedup(itemId),
    });
    return item;
  }

  // ──────────────────────────────────────────────────────── Helpers

  private async enqueuePlan(workspaceId: string, id: string) {
    await this.scheduledJobs.schedule({
      workspaceId, kind: SOCIAL_CAMPAIGN_PLAN_KIND, runAt: new Date(),
      payload: { campaignId: id, workspaceId }, dedupKey: planDedup(id),
    });
  }

  private async getOwned(workspaceId: string, id: string) {
    const c = await this.prisma.socialCampaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Social campaign not found');
    return c;
  }

  private async getOwnedItem(workspaceId: string, itemId: string) {
    const item = await this.prisma.socialCampaignItem.findFirst({ where: { id: itemId, workspaceId } });
    if (!item) throw new NotFoundException('Campaign item not found');
    return item;
  }

  async bumpStats(campaignId: string, delta: Record<string, number>): Promise<void> {
    const c = await this.prisma.socialCampaign.findUnique({
      where: { id: campaignId }, select: { stats: true },
    });
    const stats = { ...((c?.stats as Record<string, number>) ?? {}) };
    for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] ?? 0) + v;
    await this.prisma.socialCampaign.update({
      where: { id: campaignId }, data: { stats: stats as Prisma.InputJsonValue },
    });
  }

  // ──────────────────────────────────────────── social.campaign.plan

  private async planTick(campaignId: string, workspaceId: string): Promise<JobHandlerResult> {
    const c = await this.prisma.socialCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!c || c.status !== 'ACTIVE') return; // stop-on-pause / cancel / completed

    const last = await this.prisma.socialCampaignItem.findFirst({
      where: { socialCampaignId: campaignId },
      orderBy: { scheduledFor: 'desc' },
      select: { scheduledFor: true, sequenceIndex: true },
    });
    const now = new Date();
    const from = last?.scheduledFor && last.scheduledFor > now ? last.scheduledFor
      : c.startDate > now ? c.startDate : now;
    const slot = nextCadenceSlot(c.cadence as unknown as Cadence, from);
    if (!slot || (c.endDate && slot > c.endDate)) {
      await this.prisma.socialCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
      return;
    }

    const brief = (c.brief ?? {}) as Record<string, any>;
    let topic: string | undefined;
    if (c.planningMode === 'USER_TOPICS') {
      // Only non-empty topics count; an empty string / gap in the middle is
      // skipped (filtered) rather than permanently stalling the campaign, and once
      // every topic is consumed the campaign COMPLETEs instead of idling ACTIVE.
      const topics: string[] = (Array.isArray(brief.topics) ? brief.topics : [])
        .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0);
      const used = await this.prisma.socialCampaignItem.count({ where: { socialCampaignId: campaignId } });
      topic = topics[used];
      if (!topic) {
        await this.prisma.socialCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
        return;
      }
    } else {
      const t = await this.contentAi.compose(workspaceId, {
        kind: 'social',
        goal: `Propose ONE short, concrete post topic (max 12 words) for: ${c.goal ?? c.name}. `
          + `Theme: ${c.theme ?? ''}. Reply with only the topic, no preamble.`,
        audience: brief.audience,
      });
      topic = t.body.split('\n')[0].trim().slice(0, 200);
    }

    const seq = (last?.sequenceIndex ?? -1) + 1;
    const item = await this.prisma.socialCampaignItem.create({
      data: { socialCampaignId: campaignId, workspaceId, sequenceIndex: seq, scheduledFor: slot, status: 'PLANNED', topic: topic ?? null },
    });
    await this.bumpStats(campaignId, { planned: 1 });

    // AI_PROPOSE waits for the user to confirm the plan (confirmPlan).
    if (c.planningMode !== 'AI_PROPOSE') {
      await this.scheduledJobs.schedule({
        workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, runAt: new Date(),
        payload: { itemId: item.id, workspaceId }, dedupKey: generateDedup(item.id),
      });
    }
    return { reschedule: { runAt: slot, payload: { campaignId, workspaceId } } };
  }

  // ─────────────────────────────────── social.campaign.item.generate

  private async generateItem(itemId: string, workspaceId: string): Promise<void> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: itemId, workspaceId }, include: { campaign: true },
    });
    if (!item || !item.campaign || item.campaign.status !== 'ACTIVE') return;
    const c = item.campaign;

    // Atomically claim the slot (PLANNED → GENERATING). A duplicate/retry job
    // finds it no longer PLANNED and no-ops, so copy/media/post are created once
    // and credits are never re-charged on retry.
    const claim = await this.prisma.socialCampaignItem.updateMany({
      where: { id: itemId, status: 'PLANNED' }, data: { status: 'GENERATING' },
    });
    if (claim.count !== 1) return;

    try {
      const brandKit = await this.prisma.brandKit.findUnique({ where: { workspaceId } });
      const brief = (c.brief ?? {}) as Record<string, any>;

      // Copy is brand-grounded transitively: ContentAiService.compose injects the BrandProfile block itself.
      const copy = await this.contentAi.compose(workspaceId, {
        kind: 'social',
        goal: item.topic ?? c.goal ?? c.name,
        tone: (brandKit as any)?.tone ?? undefined,
        audience: brief.audience,
        context: [c.theme, brief.keyMessages, (brandKit as any)?.defaultCta].filter(Boolean).join('\n') || undefined,
      });

      const refImages: string[] = Array.isArray((brandKit as any)?.referenceImages)
        ? ((brandKit as any).referenceImages as any[]).map((r) => r?.url).filter(Boolean) : [];
      const kinds = c.mediaKinds.length ? c.mediaKinds : ['IMAGE'];
      const assetIds: string[] = [];
      try {
        for (const kind of kinds) {
          const isVideo = kind === 'VIDEO';
          const { assetId } = await this.mediaGen.requestGeneration(workspaceId, {
            type: isVideo ? 'VIDEO' : 'IMAGE',
            prompt: `${item.topic ?? c.theme ?? c.name}. ${copy.body}`.slice(0, 1500),
            model: (isVideo ? c.defaultVideoModel : c.defaultImageModel) ?? undefined,
            referenceImageUrls: refImages,
            socialCampaignId: c.id,
            campaignItemId: item.id,
            createdById: c.createdById,
          });
          assetIds.push(assetId);
        }
      } catch (e) {
        // If AI media generation is not configured (no FAL_KEY) the provider throws
        // MEDIA_GEN_NOT_CONFIGURED. Ship the post TEXT-ONLY rather than failing the
        // whole campaign item (which is why "campaign posts had no photo"). Any
        // other error is a real failure and still aborts the item.
        if (e instanceof ServiceUnavailableException) {
          this.logger.warn(`media generation unavailable for campaign ${c.id} — creating a text-only post (set FAL_KEY to enable AI images)`);
        } else {
          throw e;
        }
      }

      const hashtags = Array.isArray((brandKit as any)?.defaultHashtags)
        ? ((brandKit as any).defaultHashtags as string[]).join(' ') : '';
      const post = await this.prisma.socialPost.create({
        data: {
          workspaceId, content: [copy.body, hashtags].filter(Boolean).join('\n\n'),
          mediaUrls: [], status: 'DRAFT', socialCampaignId: c.id, campaignItemId: item.id,
        },
      });

      // FULL_AUTO → SCHEDULED + armed; SEMI_AUTO → NEEDS_APPROVAL + armed (the
      // review window: publishes at the slot unless rejected first); APPROVAL →
      // NEEDS_APPROVAL, and `approveItem` arms the gate. The rule itself lives in
      // `CampaignItemArmingService` because the CONCEPT producer has to obey the
      // identical one — see that file for why it is shared rather than copied.
      await this.arming.arm({
        workspaceId,
        itemId,
        automationMode: c.automationMode,
        scheduledFor: item.scheduledFor,
        data: { socialPostId: post.id, generatedAssetIds: assetIds },
      });
      await this.bumpStats(c.id, { generated: 1 });
    } catch (e) {
      // Mark FAILED and DO NOT rethrow — rethrowing would make the runner retry
      // the whole method and re-charge credits / duplicate assets+posts.
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'FAILED', error: String((e as Error)?.message ?? e).slice(0, 500) },
      }).catch(() => undefined);
    }
  }

  // ──────────────────────────────────── social.campaign.item.confirm

  private async confirmItem(itemId: string, workspaceId: string): Promise<JobHandlerResult> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: itemId, workspaceId }, include: { campaign: true },
    });
    if (!item || !item.campaign || !item.socialPostId) return;
    const c = item.campaign;
    if (c.status !== 'ACTIVE') {
      // Paused mid-window: keep the gate pending so resume re-fires it instead of
      // silently dropping the (already-generated) item. Cancelled/completed: drop.
      if (c.status === 'PAUSED') {
        return { reschedule: { runAt: new Date(Date.now() + 60 * 60 * 1000), payload: { itemId, workspaceId } } };
      }
      return;
    }

    // Publishable source states. FULL_AUTO/APPROVAL publish only from SCHEDULED
    // (auto or user-approved); SEMI_AUTO also auto-publishes from NEEDS_APPROVAL
    // unless the user rejected it (→ SKIPPED, which matches neither and is dropped).
    const publishableFrom: SocialCampaignItemStatus[] = c.automationMode === 'SEMI_AUTO'
      ? ['SCHEDULED', 'NEEDS_APPROVAL']
      : ['SCHEDULED'];
    if (!publishableFrom.includes(item.status)) return;

    // Don't publish before the generated media is READY: for a near-term slot the
    // asset may still be GENERATING. Retry (bounded) instead of publishing a
    // text-only post and terminalizing the item, which would orphan the media that
    // finishes moments later.
    const assetIds = item.generatedAssetIds ?? [];
    const assetRows = assetIds.length
      ? await this.prisma.generatedAsset.findMany({
          where: { id: { in: assetIds }, workspaceId },
          select: { id: true, status: true, url: true, r2Key: true, mime: true },
        })
      : [];
    // IN THE ORDER THEY WERE BOUGHT, which is the order they must be watched in.
    //
    // `generatedAssetIds` is beat order: the concept producer appends one id per
    // beat as it submits them, so index 0 is the hook and the last is the payoff.
    // `findMany` with an `id: { in: [...] }` has NO ordering guarantee — Postgres
    // returns whatever the scan produces, which is neither the IN-list order nor
    // insertion order once a row has been updated in place (every one of these is
    // updated at least twice: QUEUED → GENERATING → READY). The list then feeds
    // `attachAssetsToPost`, which writes `mediaUrls` positionally, and an
    // Instagram carousel plays its children in exactly that order — so a
    // five-beat concept could publish its call-to-action first and its hook
    // fourth, with nothing anywhere reporting a fault. The tests could not see
    // it: a mocked `findMany` hands rows back in the order the spec wrote them.
    //
    // Reordering here rather than at the write covers every reader — the pending
    // check, the "none of them can be sent" message and the attach all see one
    // list, in one order.
    //
    // A SORT, never a rebuild from `assetIds`. Rebuilding by lookup would DROP a
    // row whose id did not match, and "dropped" is indistinguishable here from
    // "the asset rows no longer exist" — which fails the item and holds a post
    // whose media was in fact fine. The count that decides the wait and the
    // refusal must survive this step untouched; only the order may change.
    const beatOrder = new Map(assetIds.map((id, i) => [id, i]));
    const assets = [...assetRows].sort(
      (a, b) =>
        (beatOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (beatOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    if (assetIds.length) {
      // Wait while ANY attached asset is still generating — not only when NONE
      // are ready. A multi-media post (e.g. IMAGE + VIDEO) whose image is READY
      // but whose video is still GENERATING must NOT publish image-only and
      // orphan the video that finishes moments later (attachAssetsToPost only
      // attaches READY assets). Bounded by the wait window so a permanently-stuck
      // asset still eventually publishes with whatever IS ready.
      const anyPending = assets.some((a) => a.status === 'QUEUED' || a.status === 'GENERATING');
      // THE WINDOW STARTS WHEN SOMEBODY STARTED WAITING, which is when the gate
      // was ARMED or when the slot arrived, whichever is later — not the slot
      // alone.
      //
      // `scheduledFor` is a CALENDAR SLOT. The concept producer buys its clips
      // at production time and reschedules itself for up to an hour while the
      // workspace generation queue is full, so a FULL_AUTO item with a slot ten
      // minutes out is routinely armed an HOUR after that slot, with every clip
      // still QUEUED. Measured from the slot, `waitedMs` was already past the
      // maximum on the gate's very first run: the wait branch was skipped, no
      // asset was READY, and the post went to every target with an empty
      // mediaUrls while the video finished minutes later with nowhere to go.
      const waitFrom = Math.max(
        new Date(item.scheduledFor).getTime(),
        item.armedAt ? new Date(item.armedAt).getTime() : 0,
      );
      const waitedMs = Date.now() - waitFrom;
      if (anyPending && waitedMs < MEDIA_READY_MAX_WAIT_MS) {
        return { reschedule: { runAt: new Date(Date.now() + MEDIA_READY_RETRY_MS), payload: { itemId, workspaceId } } };
      }
    }

    // A POST THAT WAS MEANT TO CARRY MEDIA NEVER GOES OUT WITHOUT ANY.
    //
    // Unconditional, and deliberately not part of the wait above: the wait is a
    // question about TIMING and this is a question about the POST. However the
    // clock lands — the window expired, the clips FAILED, the URLs never
    // arrived — a caption published where a video was approved is not the
    // content anybody agreed to, and on the concept line the caption alone is
    // not the content at all. The item is FAILED with the asset states named, so
    // the clips (already paid for) stay on the row and a human can see exactly
    // what happened instead of finding a bare caption live on every channel.
    //
    // The claim below is what makes this safe to write: it is a conditional
    // update over the same publishable states, so a gate that loses the race to
    // another runner changes nothing.
    const attachable = assets.filter(isAttachable);
    if (assetIds.length && !attachable.length) {
      const states = assets.length
        ? assets.map(describeAsset).sort().join(', ')
        : 'the asset rows no longer exist';
      const why =
        `not published: this post was built around ${assetIds.length} generated file(s) and none of them can be sent ` +
        `(${states}). Publishing now would have put the caption out with no media. The generated clips are still on this item, ` +
        `so nothing was lost — retry once the media is ready, or regenerate it.`;
      const held = await this.prisma.socialCampaignItem.updateMany({
        where: { id: itemId, status: { in: publishableFrom } },
        data: { status: 'FAILED', error: why.slice(0, 500) },
      });
      if (held.count) this.logger.warn(`item ${itemId} ${why}`);
      return;
    }

    // dailyPublishCap rollover — count items already PUBLISHED in this UTC day.
    const dayStart = new Date(item.scheduledFor); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const publishedToday = await this.prisma.socialCampaignItem.count({
      where: { socialCampaignId: c.id, status: 'PUBLISHED', scheduledFor: { gte: dayStart, lt: dayEnd } },
    });
    if (publishedToday >= c.dailyPublishCap) {
      const next = new Date(item.scheduledFor); next.setUTCDate(next.getUTCDate() + 1);
      await this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { scheduledFor: next } });
      return { reschedule: { runAt: next, payload: { itemId, workspaceId } } };
    }

    // JOIN THE BEATS INTO THE VIDEO THIS ITEM WAS APPROVED AS.
    //
    // BEFORE the claim, on purpose. Assembly re-encodes every clip and can take
    // minutes; after the claim, a crash or a timeout in the middle would leave
    // an item marked PUBLISHED that was never published, and the gate no-ops on
    // retry by design. Before it, the worst case is that the next run encodes
    // again — wasted CPU, and nothing lost.
    const assembledUrl = await this.assembleConceptVideo(workspaceId, item, attachable);

    // Atomically claim the publish (publishableFrom → PUBLISHED) BEFORE the paid
    // brand-safety check and schedulePost. If a later step throws and the runner
    // retries, the item is already PUBLISHED (no longer in publishableFrom) so the
    // gate no-ops instead of re-charging credits and re-publishing the post.
    const claim = await this.prisma.socialCampaignItem.updateMany({
      where: { id: itemId, status: { in: publishableFrom } },
      data: { status: 'PUBLISHED' },
    });
    if (claim.count !== 1) return;

    const post = await this.prisma.socialPost.findFirst({
      where: { id: item.socialPostId, workspaceId }, select: { id: true, content: true },
    });
    if (!post) return;

    // FAIL-OPEN, deliberately, and only here: this item exists because a person
    // built the campaign and its copy passed through the item lifecycle they can
    // see. A provider outage on that path strands a chain a human started, so an
    // unreadable verdict lets it through. The unattended community path decides
    // the opposite way, for the opposite reason — see CommunityEngageExecutor.
    const blocked = (await this.brandSafety.screen(workspaceId, post.content)) === 'BLOCK';
    if (blocked) {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'SKIPPED', error: 'Blocked by brand-safety check' },
      });
      return;
    }

    // Attach the generated media to the post before it goes out, then hand off
    // to the existing social.publish path (per-network adapters unchanged).
    // An assembled video is not a subset of the clips — every beat is INSIDE
    // it — so there is nothing dropped to report and nothing for the positional
    // attach to do. Reporting "1 of 5 attached" here would name a loss that did
    // not happen.
    let dropped: string | null = null;
    if (assembledUrl) {
      await this.prisma.socialPost.update({ where: { id: post.id }, data: { mediaUrls: [assembledUrl] } });
    } else {
      dropped = await this.attachAssetsToPost(post.id, assets, assetIds);
    }
    if (dropped) {
      // PUBLISHED, with the sentence. The post is live and its media is what
      // reached it; what did not reach it is now a fact on the row rather than
      // an absence nobody can see. Same shape the publish path uses for a
      // platform that could not carry every file (`PublishResult.droppedMedia`),
      // one layer up, because the loss is the same loss: the workspace was
      // charged for every clip either way.
      this.logger.warn(`item ${itemId} published, ${dropped}`);
      await this.prisma.socialCampaignItem
        .update({ where: { id: itemId }, data: { error: `published, ${dropped}`.slice(0, 500) } })
        .catch(() => undefined);
    }
    await this.planner.schedulePost(workspaceId, post.id, new Date(), c.targetAccountIds);
    await this.bumpStats(c.id, { published: 1 });
  }

  /**
   * The concept's beats, joined into the one video it was approved as.
   *
   * A five-beat concept buys five generations and, until this existed, handed
   * five separate files to a publisher that can send one or two of them. The
   * rest were paid for and thrown away, and the thing the reviewer approved — a
   * hook, then a demo, then a proof, then the call to action, in that order —
   * existed nowhere.
   *
   * Returns null to mean "publish the clips as they are", and returns it for
   * every reason including failure. Assembly is an IMPROVEMENT on the old
   * behaviour, so it must never be able to take a post down: an ffmpeg that is
   * missing, a render that times out, a clip that will not download all leave
   * the item exactly where it would have been without this method.
   */
  private async assembleConceptVideo(
    workspaceId: string,
    item: { id: string; contentConceptId: string | null },
    attachable: { id: string; url: string | null; mime: string | null }[],
  ): Promise<string | null> {
    // Only the concept line has beats. A cadence-planned item is one asset.
    if (!item.contentConceptId) return null;
    const clips = attachable.filter((a) => a.url && (a.mime ?? '').startsWith('video/'));
    // One clip is already the video; joining it would re-encode for nothing.
    if (clips.length < 2) return null;
    if (!this.r2.isConfigured()) return null;

    try {
      const concept = await this.prisma.contentConcept.findFirst({
        where: { id: item.contentConceptId, workspaceId },
        select: { shotPlan: true },
      });
      const plan = (concept?.shotPlan ?? null) as { shots?: { onScreenText?: string }[]; aspectRatio?: string } | null;
      const shots = Array.isArray(plan?.shots) ? plan.shots : [];

      // BEAT ORDER, and the caller already guaranteed it: `assets` was sorted
      // into `generatedAssetIds` order before any of this, so index i here is
      // beat i there and the words burned over a clip are the words written for
      // it. Pairing by anything else would caption the hook with the payoff.
      const result = await this.assembly.assemble(
        clips.map((c, i) => ({ url: c.url as string, onScreenText: shots[i]?.onScreenText ?? null })),
        plan?.aspectRatio,
      );
      if (result.error || !result.path) {
        this.logger.warn(`item ${item.id}: clips published unjoined (${result.error})`);
        return null;
      }

      try {
        const buffer = await readFile(result.path);
        const stored = await this.r2.upload(workspaceId, {
          buffer,
          mimetype: 'video/mp4',
          originalname: `concept-${item.id}.mp4`,
        } as never);
        return stored.url;
      } finally {
        await unlink(result.path).catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn(`item ${item.id}: assembly failed, publishing the clips as they are: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
  }

  /**
   * Copy the READY assets' URLs onto the post so it publishes with media (assets
   * generate async, so this runs at publish time, not at create).
   *
   * RETURNS WHAT IT LEFT BEHIND. Selecting `status: 'READY'` and writing those
   * URLs is correct — a FAILED or still-QUEUED clip has no URL to send — but
   * doing it silently is the same defect the adapters were just fixed for, one
   * layer higher: the workspace was charged for every clip in `assetIds`, and a
   * post that goes out with three of five had two paid renders disappear with no
   * error, no warning and no record. The caller writes the sentence onto the
   * item; the adapters write theirs onto the target row. Neither pretends more
   * was sent than was.
   *
   * The assets are passed in rather than re-read: the gate has already read them
   * to decide whether to wait at all, and a second read is a second answer —
   * one that could have changed between the decision and the write.
   *
   * COUNTED AGAINST WHAT WAS PAID FOR, not against what was found. `assetIds`
   * is the item's own list — one id per beat, one purchase each — and `assets`
   * is the rows that came back for them. Reporting "N of M" over the ROWS made
   * the worst case invisible: a clip whose row had vanished entirely was
   * missing from both sides of the fraction, so five bought, one row left and
   * one attached reported nothing wrong at all. The id is the receipt; the row
   * is only evidence about it.
   */
  private async attachAssetsToPost(
    postId: string,
    assets: { id: string; status: string; url: string | null; r2Key: string | null; mime: string | null }[],
    /** Every asset id the item PAID for, in beat order. */
    assetIds: string[],
  ): Promise<string | null> {
    const ready = assets.filter(isAttachable);
    if (!ready.length) return null;
    await this.prisma.socialPost.update({
      where: { id: postId },
      data: {
        mediaUrls: ready.map((a) => a.url as string),
        options: { media: ready.map((a) => ({ url: a.url, key: a.r2Key, mime: a.mime })) } as unknown as Prisma.InputJsonValue,
      },
    });
    const attached = new Set(ready.map((a) => a.id));
    const lost = assetIds.filter((id) => !attached.has(id));
    if (!lost.length) return null;
    const rowById = new Map(assets.map((a) => [a.id, a]));
    const states = lost
      .map((id) => {
        const row = rowById.get(id);
        // "the row is gone" is a DIFFERENT fact from FAILED or GENERATING, and
        // it is the one nobody could see before.
        return row ? describeAsset(row) : 'the asset row no longer exists';
      })
      .sort()
      .join(', ');
    return `but ${lost.length} of ${assetIds.length} generated file(s) were not attached (${states}) — they were paid for and are still on this item`;
  }
}
