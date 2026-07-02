import type {
  SocialCampaign,
  SocialCampaignItem,
  SocialCampaignItemStatus,
} from '../../../features/marketing/api/socialCampaigns.service';

/**
 * The single source of truth for "what is this campaign doing right now?".
 * Pure + deterministic (inject `now`) so the UI can always tell the user the
 * current phase + next action instead of a bare empty screen.
 */
export type CampaignPhase =
  | 'draft' // saved, not launched
  | 'planning' // ACTIVE, no items yet — the background planner is composing the first slot
  | 'awaiting_confirm' // ACTIVE, AI proposed a plan the user must confirm to start generation
  | 'generating' // ACTIVE, content (copy + media) is being produced or queued to be produced
  | 'needs_approval' // ACTIVE, posts are waiting for the user's review
  | 'running' // ACTIVE, everything on track — upcoming posts scheduled
  | 'idle' // ACTIVE but nothing in flight (between cadence ticks / nothing pending)
  | 'paused'
  | 'completed'
  | 'cancelled';

export const ALL_ITEM_STATUSES: SocialCampaignItemStatus[] = [
  'PLANNED',
  'GENERATING',
  'NEEDS_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHED',
  'FAILED',
  'SKIPPED',
];

const TERMINAL: SocialCampaignItemStatus[] = ['PUBLISHED', 'FAILED', 'SKIPPED'];

export interface CampaignState {
  phase: CampaignPhase;
  counts: Record<SocialCampaignItemStatus, number>;
  total: number;
  published: number;
  /** total − skipped: the denominator that can actually reach 100%. */
  publishableTotal: number;
  publishedPct: number; // published / publishableTotal, 0 when empty
  inFlight: number; // non-terminal items
  needsApproval: number;
  generating: number; // items with status GENERATING (raw)
  /** GENERATING + PLANNED: items in the pre-publish creation pipeline. */
  creating: number;
  failed: number;
  skipped: number;
  /** AI proposed a plan (PLANNED items) that the user must confirm to begin. */
  awaitingConfirm: boolean;
  /** ISO of the earliest UPCOMING non-terminal post, or null. */
  nextScheduledFor: string | null;
}

export function deriveCampaignState(
  campaign: Pick<SocialCampaign, 'status' | 'planningMode'>,
  items: Pick<SocialCampaignItem, 'status' | 'scheduledFor'>[],
  now: Date = new Date(),
): CampaignState {
  const counts = Object.fromEntries(ALL_ITEM_STATUSES.map((s) => [s, 0])) as Record<
    SocialCampaignItemStatus,
    number
  >;
  for (const it of items) {
    if (counts[it.status] !== undefined) counts[it.status] += 1;
  }

  const total = items.length;
  const published = counts.PUBLISHED;
  const failed = counts.FAILED;
  const skipped = counts.SKIPPED;
  const generating = counts.GENERATING;
  const needsApproval = counts.NEEDS_APPROVAL;
  const planned = counts.PLANNED;
  const scheduled = counts.SCHEDULED;
  const creating = generating + planned;
  const inFlight = total - published - failed - skipped;
  // Skipped posts were deliberately dropped (rejected / brand-safety), so they
  // don't count against progress — otherwise the bar could never reach 100%.
  const publishableTotal = total - skipped;
  const publishedPct = publishableTotal > 0 ? Math.round((published / publishableTotal) * 100) : 0;

  // Something is already downstream of "just proposed": actively generating,
  // waiting for the user's review, or scheduled to publish. When true, a freshly
  // proposed PLANNED slot must NOT hijack the hero with a "Confirm plan" CTA that
  // cannot resolve the more-actionable state (confirmPlan only fans out PLANNED).
  const inProgress = generating > 0 || needsApproval > 0 || scheduled > 0 || counts.APPROVED > 0;
  const awaitingConfirm = campaign.planningMode === 'AI_PROPOSE' && planned > 0 && !inProgress;

  const nowMs = now.getTime();
  const nextScheduledFor =
    items
      .filter((it) => !TERMINAL.includes(it.status))
      .map((it) => it.scheduledFor)
      .filter((d) => new Date(d).getTime() >= nowMs)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? null;

  let phase: CampaignPhase;
  if (campaign.status === 'DRAFT') phase = 'draft';
  else if (campaign.status === 'PAUSED') phase = 'paused';
  else if (campaign.status === 'CANCELLED') phase = 'cancelled';
  else if (campaign.status === 'COMPLETED') phase = 'completed';
  // Priority reflects "what needs attention or is actively happening", so the
  // hero never masks an actionable state behind a lower-priority one:
  else if (needsApproval > 0) phase = 'needs_approval'; // user should review
  else if (awaitingConfirm) phase = 'awaiting_confirm'; // a fresh plan to confirm (nothing downstream)
  else if (creating > 0) phase = 'generating'; // being created, or queued to create (PLANNED)
  else if (scheduled > 0) phase = 'running'; // created + scheduled, waiting to publish
  else if (total === 0) phase = 'planning'; // ACTIVE, planner composing the first slot
  else if (inFlight > 0) phase = 'running';
  else phase = 'idle';

  return {
    phase,
    counts,
    total,
    published,
    publishableTotal,
    publishedPct,
    inFlight,
    needsApproval,
    generating,
    creating,
    failed,
    skipped,
    awaitingConfirm,
    nextScheduledFor,
  };
}
