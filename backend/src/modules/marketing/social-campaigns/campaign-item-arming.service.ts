import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

export const SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND = 'social.campaign.item.confirm';
export const confirmDedup = (id: string) => `social-campaign-confirm-${id}`;

/** The three autonomy settings a campaign can be in. Restated as values (the
 *  Prisma enum is a type, and a type refuses nothing to a string that arrived
 *  from a JSON column) so the branch below can be exhaustive at runtime. */
export type CampaignAutomationMode = 'FULL_AUTO' | 'SEMI_AUTO' | 'APPROVAL';

/** What arming a generated item means, per mode. Pure, so the RULE can be
 *  asserted directly and both producers provably share one answer. */
export interface ArmingDecision {
  /** Where the item lands once its media exists. */
  status: 'SCHEDULED' | 'NEEDS_APPROVAL';
  /** Whether the confirm gate is scheduled now, or waits for a human to click
   *  Approve (which arms this exact job, with this exact dedup key). */
  arm: boolean;
}

/**
 * FULL_AUTO → SCHEDULED and armed. SEMI_AUTO → NEEDS_APPROVAL *and* armed (the
 * review WINDOW: it publishes at the slot unless a human rejects first).
 * APPROVAL, and anything unrecognised, → NEEDS_APPROVAL and NOT armed.
 *
 * The unrecognised case falls to the strictest branch on purpose: a mode this
 * code does not know is not a licence to publish unattended.
 */
export function armingFor(automationMode: string): ArmingDecision {
  if (automationMode === 'FULL_AUTO') return { status: 'SCHEDULED', arm: true };
  if (automationMode === 'SEMI_AUTO') return { status: 'NEEDS_APPROVAL', arm: true };
  return { status: 'NEEDS_APPROVAL', arm: false };
}

/**
 * What a HUMAN clicking Approve means, in the same vocabulary.
 *
 * It is not `armingFor('FULL_AUTO')` spelled differently — it is a different
 * question with the same answer, and passing a mode the campaign is not in, in
 * order to reach the branch we want, is how the third copy of this rule got
 * written in the first place. An explicit decision keeps "the owner chose
 * autonomy" and "a person clicked Approve" distinguishable at the call site
 * while they share ONE implementation of the write and the schedule.
 */
export const APPROVED_ARMING: ArmingDecision = { status: 'SCHEDULED', arm: true };

/**
 * The one place a generated campaign item is handed to the publish gate.
 *
 * ## Why this is a service and not a copied `if`
 *
 * TWO producers finish an item and have to decide what happens next:
 * `SocialCampaignsService.generateItem` (the generic AI planner) and
 * `ConceptPromotionService.produce` (the content-concept line). The second one
 * did not branch on `automationMode` at all — it wrote `NEEDS_APPROVAL` and
 * scheduled nothing — so a workspace that had chosen FULL_AUTO got a SECOND
 * human gate on every concept it produced, and the item sat in the approval
 * queue forever with no way to know the mode had been ignored. That is the
 * exact opposite of what the concept path documents about itself: "the human
 * decision stays exactly where the owner put it: once, on the concept."
 *
 * The fix could have been a second copy of the branch. It is not, because the
 * branch is an AUTONOMY rule about money and publishing: a copy is a place for
 * the two to drift, and the direction they drift in is "one of them publishes
 * unattended when it should not". One implementation, two callers, so a change
 * to what FULL_AUTO means cannot reach one producer and miss the other.
 *
 * THREE callers, in fact: `SocialCampaignsService.approveItem` — the human
 * clicking Approve — kept a copy of the same status + schedule + dedup triple
 * and was left alone when this service was extracted. It is `armApproved` now.
 * The cost of that copy was not hypothetical: the media-ready window is
 * measured from `armedAt`, and an arming door that does not stamp it is a door
 * that publishes a caption with no video.
 *
 * ## What this does NOT decide
 *
 * Every gate that actually protects the customer stays downstream, in
 * `confirmItem`, and this service deliberately owns none of it: the campaign
 * must still be ACTIVE, the media must still be READY (or the wait must have
 * expired), `dailyPublishCap` still applies, brand-safety still runs. Arming
 * schedules a gate; it does not open one. That is why arming the concept path
 * identically cannot loosen anything — the job kind, the dedup key and the run
 * time are the same ones `approveItem` uses when a human clicks Approve.
 */
@Injectable()
export class CampaignItemArmingService {
  private readonly logger = new Logger(CampaignItemArmingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
  ) {}

  /**
   * Move a finished item to its post-generation status and, where the mode says
   * so, schedule the confirm gate.
   *
   * `data` carries whatever else the producer must write in the SAME update —
   * the post id, the paid-for asset ids, a cleared error — so an item can never
   * be observed at its final status without them.
   */
  async arm(args: {
    workspaceId: string;
    itemId: string;
    automationMode: string;
    /** The slot the confirm gate fires at. The item's own `scheduledFor`. */
    scheduledFor: Date;
    data?: Prisma.SocialCampaignItemUncheckedUpdateInput;
  }): Promise<ArmingDecision> {
    const decision = armingFor(args.automationMode);
    if (!decision.arm) {
      this.logger.debug(
        `item ${args.itemId} held at NEEDS_APPROVAL (${args.automationMode}) — the confirm gate is armed by an explicit approval`,
      );
    }
    await this.apply(decision, args);
    return decision;
  }

  /**
   * The THIRD writer of this rule, folded in.
   *
   * `SocialCampaignsService.approveItem` kept its own copy of status + schedule
   * + dedup key long after this service existed to hold exactly that, and the
   * copy is not free: the media-ready window is measured from `armedAt`, and a
   * second place that arms without stamping it publishes a caption with no
   * video. One implementation means a fix to what arming MEANS reaches every
   * door that arms, including the human one.
   *
   * Returns the updated row, because the approval endpoint answers with it.
   */
  async armApproved(args: {
    workspaceId: string;
    itemId: string;
    scheduledFor: Date;
    data?: Prisma.SocialCampaignItemUncheckedUpdateInput;
  }) {
    return this.apply(APPROVED_ARMING, args);
  }

  /**
   * The write and the schedule, once.
   *
   * `armedAt` is stamped in the SAME update as the status, and only when the
   * gate is actually armed: it is the moment the wait for media begins, and
   * `confirmItem` measures its bounded wait from `max(scheduledFor, armedAt)`.
   * Stamping it on an item that is NOT armed would date a window nobody opened;
   * leaving it off an item that IS armed puts the window back on `scheduledFor`,
   * which is a calendar slot that may already be hours in the past — the exact
   * shape of the empty-media publish this column was added to end.
   */
  private async apply(
    decision: ArmingDecision,
    args: {
      workspaceId: string;
      itemId: string;
      scheduledFor: Date;
      data?: Prisma.SocialCampaignItemUncheckedUpdateInput;
    },
  ) {
    const updated = await this.prisma.socialCampaignItem.update({
      where: { id: args.itemId },
      data: {
        ...(args.data ?? {}),
        status: decision.status,
        ...(decision.arm ? { armedAt: new Date() } : {}),
      },
    });

    if (decision.arm) {
      await this.scheduledJobs.schedule({
        workspaceId: args.workspaceId,
        kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
        runAt: args.scheduledFor,
        payload: { itemId: args.itemId, workspaceId: args.workspaceId },
        // One dedup key for every door: a human approving an item that autonomy
        // already armed collapses onto the pending job instead of queueing a
        // second publish.
        dedupKey: confirmDedup(args.itemId),
      });
    }

    return updated;
  }
}
