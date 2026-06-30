import {
  BadRequestException, Injectable, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService, ClaimedJob, JobHandlerResult,
} from '../scheduling/scheduled-job-runner.service';
import { ContentAiService } from '../ai/content-ai.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { MediaGenService } from '../ai/media/media-gen.service'; // Milestone 1
import { SocialPlannerService } from '../social-planner/social-planner.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { Cadence, nextCadenceSlot } from './cadence.util';

export const SOCIAL_CAMPAIGN_PLAN_KIND = 'social.campaign.plan';
export const SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND = 'social.campaign.item.generate';
export const SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND = 'social.campaign.item.confirm';

export const planDedup = (id: string) => `social-campaign-plan-${id}`;
export const generateDedup = (id: string) => `social-campaign-generate-${id}`;
export const confirmDedup = (id: string) => `social-campaign-confirm-${id}`;

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
  createdById: string;
}

@Injectable()
export class SocialCampaignsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly contentAi: ContentAiService,
    private readonly planner: SocialPlannerService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly mediaGen: MediaGenService,
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

  async create(workspaceId: string, input: CreateSocialCampaignInput) {
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
        createdById: input.createdById,
        status: 'DRAFT',
      },
    });
  }

  list(workspaceId: string) {
    return this.prisma.socialCampaign.findMany({
      where: { workspaceId }, orderBy: { createdAt: 'desc' },
    });
  }

  async get(workspaceId: string, id: string) {
    return this.getOwned(workspaceId, id);
  }

  async update(workspaceId: string, id: string, patch: Partial<CreateSocialCampaignInput>) {
    const c = await this.getOwned(workspaceId, id);
    if (c.status !== 'DRAFT') {
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

  listItems(workspaceId: string, campaignId: string) {
    return this.prisma.socialCampaignItem.findMany({
      where: { workspaceId, socialCampaignId: campaignId },
      orderBy: { sequenceIndex: 'asc' },
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
    return this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'APPROVED' } });
  }

  async rejectItem(workspaceId: string, itemId: string) {
    await this.getOwnedItem(workspaceId, itemId);
    return this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'SKIPPED' } });
  }

  async regenerateItem(workspaceId: string, itemId: string) {
    const item = await this.getOwnedItem(workspaceId, itemId);
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
      const topics: string[] = Array.isArray(brief.topics) ? brief.topics : [];
      const used = await this.prisma.socialCampaignItem.count({ where: { socialCampaignId: campaignId } });
      topic = topics[used];
      if (!topic) return; // user supplied no further topics — idle (no reschedule)
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
    await this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'GENERATING' } });

    const brandKit = await this.prisma.brandKit.findUnique({ where: { workspaceId } });
    const brief = (c.brief ?? {}) as Record<string, any>;

    let copy: { body: string };
    try {
      copy = await this.contentAi.compose(workspaceId, {
        kind: 'social',
        goal: item.topic ?? c.goal ?? c.name,
        tone: (brandKit as any)?.tone ?? undefined,
        audience: brief.audience,
        context: [c.theme, brief.keyMessages, (brandKit as any)?.defaultCta].filter(Boolean).join('\n') || undefined,
      });
    } catch (e) {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'FAILED', error: String((e as Error).message).slice(0, 500) },
      });
      return;
    }

    const refImages: string[] = Array.isArray((brandKit as any)?.referenceImages)
      ? ((brandKit as any).referenceImages as any[]).map((r) => r?.url).filter(Boolean) : [];
    const kinds = c.mediaKinds.length ? c.mediaKinds : ['IMAGE'];
    const assetIds: string[] = [];
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

    const hashtags = Array.isArray((brandKit as any)?.defaultHashtags)
      ? ((brandKit as any).defaultHashtags as string[]).join(' ') : '';
    const post = await this.prisma.socialPost.create({
      data: {
        workspaceId, content: [copy.body, hashtags].filter(Boolean).join('\n\n'),
        mediaUrls: [], status: 'DRAFT', socialCampaignId: c.id, campaignItemId: item.id,
      },
    });

    if (c.automationMode === 'APPROVAL') {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'NEEDS_APPROVAL', socialPostId: post.id, generatedAssetIds: assetIds },
      });
    } else {
      // SEMI_AUTO + FULL_AUTO: schedule the slot and gate it at scheduledFor.
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'SCHEDULED', socialPostId: post.id, generatedAssetIds: assetIds },
      });
      await this.scheduledJobs.schedule({
        workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, runAt: item.scheduledFor,
        payload: { itemId, workspaceId }, dedupKey: confirmDedup(itemId),
      });
    }
    await this.bumpStats(c.id, { generated: 1 });
  }

  // ──────────────────────────────────── social.campaign.item.confirm

  private async confirmItem(itemId: string, workspaceId: string): Promise<JobHandlerResult> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: itemId, workspaceId }, include: { campaign: true },
    });
    if (!item || !item.campaign || !item.socialPostId) return;
    const c = item.campaign;
    if (c.status !== 'ACTIVE') return; // stop-on-pause / cancel

    // User veto (reject set the item SKIPPED before the gate fired).
    if (item.status !== 'SCHEDULED') return;

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

    const post = await this.prisma.socialPost.findFirst({
      where: { id: item.socialPostId, workspaceId }, select: { id: true, content: true },
    });
    if (!post) return;

    const safe = await this.brandSafetyCheck(workspaceId, post.content);
    if (!safe) {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'SKIPPED', error: 'Blocked by brand-safety check' },
      });
      return;
    }

    // Hand off to the existing social.publish path (per-network adapters unchanged).
    await this.planner.schedulePost(workspaceId, post.id, new Date(), c.targetAccountIds);
    await this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'PUBLISHED' } });
    await this.bumpStats(c.id, { published: 1 });
  }

  /** SAFE/BLOCK copy screen via Claude; inert (allow) when AI is disabled. */
  private async brandSafetyCheck(workspaceId: string, copy: string): Promise<boolean> {
    if (!this.anthropic.isEnabled()) return true;
    await this.credits.reserve(workspaceId, creditCost('workflow.ai_classify'));
    try {
      const res = await this.anthropic.complete({
        system: 'You are a brand-safety reviewer. Reply with exactly one word: SAFE or BLOCK. '
          + 'BLOCK only for hate, harassment, sexually explicit, illegal, or defamatory content.',
        messages: [{ role: 'user', content: copy.slice(0, 2000) }],
        maxTokens: 4,
        tier: tierFor('workflow.ai_classify'),
      });
      return !/BLOCK/i.test(res.text);
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('workflow.ai_classify'));
      return true; // fail-open on transient errors — don't strand the chain
    }
  }
}
