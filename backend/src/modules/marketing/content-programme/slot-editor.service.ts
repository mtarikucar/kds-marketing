import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ContentSlot, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { SocialCampaignsService } from '../social-campaigns/social-campaigns.service';
import { CampaignItemArmingService } from '../social-campaigns/campaign-item-arming.service';
import { ContentProgrammeService } from './content-programme.service';
import { CONTENT_SLOT_PLAN_KIND, cancelSlotJobs, scheduleSlotJobs, slotPlanDedup } from './programme-planner.service';

/** Statuses an owner may still touch: nothing bought (PLANNED), frames only
 *  (IDEATED), or clips made but not yet out (READY — time only). */
export const EDITABLE_SLOT_STATUSES = ['PLANNED', 'IDEATED', 'READY'] as const;
/** The concept planner's own idea limit, held here so a rejected edit says so
 *  at the door rather than after a job has spent a credit. */
const MAX_IDEA_CHARS = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Item statuses `regenerateItem` accepts as they are (see REGENERATABLE_STATES there). */
const ITEM_REGENERATABLE = ['PLANNED', 'NEEDS_APPROVAL', 'FAILED', 'SKIPPED'];
/** Item statuses the publish gate may still fire from — the ones a moved time must re-arm. */
const ITEM_ARMED = ['SCHEDULED', 'NEEDS_APPROVAL'];

export interface SlotPatch {
  contentTypeKey?: string;
  idea?: string;
  scheduledFor?: Date;
}

export interface SlotMetricsView {
  slot: ContentSlot;
  concept: { id: string; title: string; hook: string; angle: string; contentTypeKey: string | null; beats: number; durationSec: number } | null;
  item: { id: string; status: string; scheduledFor: Date; error: string | null } | null;
  post: { id: string; publishedAt: Date | null; content: string } | null;
  targets: Array<{
    network: string;
    status: string;
    latest: {
      impressions: number; reach: number; engagements: number; likes: number; comments: number;
      shares: number; saves: number; videoViews: number; leads: number; date: Date;
    } | null;
  }>;
  reward: number | null;
  rewardBreakdown: unknown;
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/**
 * THE OWNER'S HANDS on a calendar the programme otherwise runs alone (design
 * K3: every step editable, no approval gate). Three moves and one read:
 *
 *   update      type / idea / time, inside the edit window; what it costs
 *               depends on how far the slot got — a PLANNED slot is rewritten,
 *               an IDEATED one gives its concept back and is planned again, a
 *               READY one only moves (its clips are bought; "different" is
 *               `regenerate`)
 *   skip        the slot is dropped and whatever it holds is released: the
 *               concept discarded, the jobs cancelled, the item rejected
 *   regenerate  READY (or FAILED with an item): the clips are re-made through
 *               the campaign's own regenerate door
 *   metrics     the slot with everything it became, down to the latest metric
 *               row per network
 *
 * Every read is workspace-scoped; an id from another workspace is NotFound,
 * never a foreign row moved.
 */
@Injectable()
export class SlotEditorService {
  private readonly logger = new Logger(SlotEditorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly programmes: ContentProgrammeService,
    private readonly socialCampaigns: SocialCampaignsService,
    private readonly arming: CampaignItemArmingService,
  ) {}

  async updateSlot(workspaceId: string, slotId: string, patch: SlotPatch, actorId: string, now = new Date()): Promise<ContentSlot> {
    const slot = await this.getOwned(workspaceId, slotId);
    const programme = await this.programmes.getOrThrow(workspaceId, slot.programmeId);
    this.requireEditable(slot, now);

    const data: Prisma.ContentSlotUncheckedUpdateInput = {};
    const changed: string[] = [];

    if (patch.contentTypeKey !== undefined && patch.contentTypeKey !== slot.contentTypeKey) {
      const type = await this.prisma.contentType.findFirst({ where: { workspaceId, key: String(patch.contentTypeKey), active: true } });
      if (!type) throw new BadRequestException(`"${patch.contentTypeKey}" is not an active content type of this workspace.`);
      data.contentTypeId = type.id;
      data.contentTypeKey = type.key;
      data.selectionReason = `owner override by ${actorId}`;
      changed.push('contentTypeKey');
    }
    if (patch.idea !== undefined) {
      const idea = typeof patch.idea === 'string' ? patch.idea.trim() : '';
      if (idea.length < 1 || idea.length > MAX_IDEA_CHARS) {
        throw new BadRequestException(`idea must be 1 to ${MAX_IDEA_CHARS} characters after trimming.`);
      }
      if (idea !== slot.idea) {
        data.idea = idea;
        changed.push('idea');
      }
    }
    let scheduledFor: Date | null = null;
    if (patch.scheduledFor !== undefined) {
      const at = patch.scheduledFor instanceof Date ? patch.scheduledFor : new Date(String(patch.scheduledFor));
      if (Number.isNaN(at.getTime())) throw new BadRequestException('scheduledFor must be a valid date.');
      if (at.getTime() <= now.getTime()) throw new BadRequestException('scheduledFor must be in the future.');
      const latest = now.getTime() + (programme.lookaheadDays + 1) * DAY_MS;
      if (at.getTime() > latest) {
        throw new BadRequestException(`scheduledFor must be within the next ${programme.lookaheadDays + 1} days (the programme's look-ahead).`);
      }
      if (at.getTime() !== slot.scheduledFor.getTime()) {
        scheduledFor = at;
        data.scheduledFor = at;
        data.editableUntil = new Date(at.getTime() - programme.editWindowHours * HOUR_MS);
        changed.push('scheduledFor');
      }
    }
    if (changed.length === 0) return slot;

    const contentChanged = changed.includes('contentTypeKey') || changed.includes('idea');
    if (slot.status === 'READY' && contentChanged) {
      throw new BadRequestException('This slot is already produced; regenerate it or skip it instead of changing its type or idea.');
    }
    if (slot.status === 'IDEATED' && contentChanged) {
      // The concept was planned for the old type/idea: give it back and start
      // the slot over. Its quote goes with it — the cap must not count a
      // concept that will never be produced.
      if (slot.conceptId) await this.discardConcept(workspaceId, slot.conceptId, programme.id, `owner edited the slot (${changed.join(', ')})`, now);
      data.status = 'PLANNED';
      data.conceptId = null;
      data.quotedCredits = null;
      data.error = null;
    }

    let updated: ContentSlot;
    try {
      updated = await this.prisma.contentSlot.update({ where: { id: slot.id }, data });
    } catch (e) {
      if (isUniqueViolation(e)) throw new BadRequestException('Another slot of this programme is already at that time.');
      throw e;
    }

    if (slot.status === 'READY' && scheduledFor) {
      await this.moveItem(workspaceId, slot, scheduledFor);
    } else if (slot.status === 'IDEATED' && contentChanged) {
      // Both jobs at the (possibly new) time, then plan pulled to now: the
      // slot re-enters the line at once instead of waiting for a lead time it
      // may already be inside.
      await scheduleSlotJobs(this.scheduledJobs, workspaceId, programme, updated, now);
      await this.scheduledJobs.cancel(CONTENT_SLOT_PLAN_KIND, slotPlanDedup(slot.id));
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CONTENT_SLOT_PLAN_KIND,
        runAt: now,
        payload: { workspaceId, slotId: slot.id, programmeId: programme.id },
        dedupKey: slotPlanDedup(slot.id),
      });
    } else if (scheduledFor) {
      await scheduleSlotJobs(this.scheduledJobs, workspaceId, programme, updated, now);
    }

    await this.programmes.logEvent(workspaceId, programme.id, 'SLOT_EDITED', `Slot ${updated.contentTypeKey} edited by ${actorId}: ${changed.join(', ')}.`, {
      slotId: slot.id, actorId, changed, from: slot.status, to: updated.status,
      ...(scheduledFor ? { scheduledFor: scheduledFor.toISOString(), previous: slot.scheduledFor.toISOString() } : {}),
    });
    return updated;
  }

  async skipSlot(workspaceId: string, slotId: string, actorId: string, now = new Date()): Promise<ContentSlot> {
    const slot = await this.getOwned(workspaceId, slotId);
    if (!(EDITABLE_SLOT_STATUSES as readonly string[]).includes(slot.status)) {
      throw new BadRequestException(`A ${slot.status} slot cannot be skipped; only PLANNED, IDEATED or READY slots can.`);
    }
    // The item first: a refusal there (already published under our feet)
    // leaves the slot as it was, rather than a SKIPPED slot over a live post.
    if (slot.status === 'READY' && slot.campaignItemId) {
      await this.socialCampaigns.rejectItem(workspaceId, slot.campaignItemId);
    }
    if (slot.conceptId) await this.discardConcept(workspaceId, slot.conceptId, slot.programmeId, `skipped by ${actorId}`, now);
    await cancelSlotJobs(this.scheduledJobs, slot.id);
    const updated = await this.prisma.contentSlot.update({
      where: { id: slot.id },
      data: { status: 'SKIPPED', error: `skipped by ${actorId}` },
    });
    await this.programmes.logEvent(workspaceId, slot.programmeId, 'SLOT_SKIPPED', `Slot ${slot.contentTypeKey} skipped by ${actorId}.`, {
      slotId: slot.id, actorId, from: slot.status, campaignItemId: slot.campaignItemId, conceptId: slot.conceptId,
    });
    return updated;
  }

  /**
   * Re-make the clips. `regenerateItem` is the campaign's own door and refuses
   * an item that is SCHEDULED (armed to publish) — the state every READY slot
   * of a FULL_AUTO programme is in — so an armed item is first rejected
   * (SCHEDULED → SKIPPED, which the gate drops) and then regenerated from
   * there. Two public transitions, no private write to the item's status.
   */
  async regenerateSlot(workspaceId: string, slotId: string, actorId: string): Promise<ContentSlot> {
    const slot = await this.getOwned(workspaceId, slotId);
    const eligible = slot.status === 'READY' || (slot.status === 'FAILED' && Boolean(slot.campaignItemId));
    if (!eligible || !slot.campaignItemId) {
      throw new BadRequestException(
        `A ${slot.status} slot${slot.campaignItemId ? '' : ' without a campaign item'} cannot be regenerated; only READY slots (or FAILED ones that reached production) can.`,
      );
    }
    const item = await this.prisma.socialCampaignItem.findFirst({ where: { id: slot.campaignItemId, workspaceId }, select: { id: true, status: true } });
    if (!item) throw new NotFoundException('Campaign item not found');
    if (item.status === 'SCHEDULED') await this.socialCampaigns.rejectItem(workspaceId, item.id);
    else if (!ITEM_REGENERATABLE.includes(item.status)) {
      throw new BadRequestException(`The slot's campaign item is ${item.status} and cannot be regenerated.`);
    }
    await this.socialCampaigns.regenerateItem(workspaceId, item.id);
    const updated = await this.prisma.contentSlot.update({
      where: { id: slot.id },
      data: { status: 'PRODUCING', error: null },
    });
    await this.programmes.logEvent(workspaceId, slot.programmeId, 'SLOT_REGENERATED', `Slot ${slot.contentTypeKey} sent back to production by ${actorId}.`, {
      slotId: slot.id, actorId, from: slot.status, campaignItemId: item.id, itemStatus: item.status,
    });
    return updated;
  }

  async slotMetrics(workspaceId: string, slotId: string): Promise<SlotMetricsView> {
    const slot = await this.getOwned(workspaceId, slotId);
    const concept = slot.conceptId
      ? await this.prisma.contentConcept.findFirst({
          where: { id: slot.conceptId, workspaceId },
          select: { id: true, title: true, hook: true, angle: true, contentTypeKey: true, shotPlan: true },
        })
      : null;
    const item = slot.campaignItemId
      ? await this.prisma.socialCampaignItem.findFirst({
          where: { id: slot.campaignItemId, workspaceId },
          select: { id: true, status: true, scheduledFor: true, error: true, socialPostId: true },
        })
      : null;
    const postId = slot.socialPostId ?? item?.socialPostId ?? null;
    const post = postId
      ? await this.prisma.socialPost.findFirst({ where: { id: postId, workspaceId }, select: { id: true, publishedAt: true, content: true } })
      : null;
    const targets: Array<{ network: string; status: string; metrics: Array<Record<string, unknown>> }> = post
      ? await this.prisma.socialPostTarget.findMany({
          where: { workspaceId, postId: post.id },
          select: { network: true, status: true, metrics: { orderBy: { date: 'desc' }, take: 1 } },
        })
      : [];
    const plan = (concept?.shotPlan ?? null) as { shots?: unknown[]; durationSec?: number } | null;
    return {
      slot,
      concept: concept
        ? {
            id: concept.id, title: concept.title, hook: concept.hook, angle: concept.angle, contentTypeKey: concept.contentTypeKey,
            beats: Array.isArray(plan?.shots) ? plan.shots.length : 0,
            durationSec: typeof plan?.durationSec === 'number' ? plan.durationSec : 0,
          }
        : null,
      item: item ? { id: item.id, status: String(item.status), scheduledFor: item.scheduledFor, error: item.error } : null,
      post: post ? { id: post.id, publishedAt: post.publishedAt, content: post.content } : null,
      targets: targets.map((t) => {
        const m = t.metrics[0];
        const n = (k: string) => Math.max(0, Number(m?.[k]) || 0);
        return {
          network: t.network,
          status: t.status,
          latest: m
            ? {
                impressions: n('impressions'), reach: n('reach'), engagements: n('engagements'), likes: n('likes'), comments: n('comments'),
                shares: n('shares'), saves: n('saves'), videoViews: n('videoViews'), leads: n('leads'), date: m.date as Date,
              }
            : null,
        };
      }),
      reward: slot.reward,
      rewardBreakdown: slot.rewardBreakdown ?? null,
    };
  }

  // ───────────────────────────────────────────────────────── internals

  private async getOwned(workspaceId: string, slotId: string): Promise<ContentSlot> {
    const slot = await this.prisma.contentSlot.findFirst({ where: { id: slotId, workspaceId } });
    if (!slot) throw new NotFoundException('Slot not found');
    return slot;
  }

  private requireEditable(slot: ContentSlot, now: Date): void {
    if (!(EDITABLE_SLOT_STATUSES as readonly string[]).includes(slot.status)) {
      throw new BadRequestException(`A ${slot.status} slot cannot be edited; only PLANNED, IDEATED or READY slots can.`);
    }
    if (now.getTime() >= slot.editableUntil.getTime()) {
      throw new BadRequestException(
        `This slot froze at ${slot.editableUntil.toISOString()} (the edit window closes before it publishes); skip it if it must not go out.`,
      );
    }
  }

  private async discardConcept(workspaceId: string, conceptId: string, programmeId: string, note: string, now: Date): Promise<void> {
    await this.prisma.contentConcept.updateMany({
      where: { id: conceptId, workspaceId, status: 'PROPOSED' },
      data: { status: 'DISCARDED', reviewedAt: now, reviewedById: `programme:${programmeId}`, reviewNote: note },
    });
  }

  /**
   * A READY slot's clips are on a campaign item whose publish gate is armed
   * for the OLD time. `armApproved` writes the new time and re-arms the gate
   * in one step, under the same dedup key the first arming used, so the
   * pending gate is moved rather than doubled. An item the gate has already
   * fired for (PUBLISHED, or mid-publish) cannot move; the slot's own time
   * was already written, so it is put back before refusing.
   */
  private async moveItem(workspaceId: string, slot: ContentSlot, scheduledFor: Date): Promise<void> {
    if (!slot.campaignItemId) return;
    const item = await this.prisma.socialCampaignItem.findFirst({ where: { id: slot.campaignItemId, workspaceId }, select: { id: true, status: true } });
    if (!item) throw new NotFoundException('Campaign item not found');
    if (!ITEM_ARMED.includes(String(item.status))) {
      await this.prisma.contentSlot.update({ where: { id: slot.id }, data: { scheduledFor: slot.scheduledFor, editableUntil: slot.editableUntil } });
      throw new BadRequestException(`The slot's campaign item is ${item.status} and can no longer be moved.`);
    }
    await this.arming.armApproved({ workspaceId, itemId: item.id, scheduledFor, data: { scheduledFor } });
  }
}
