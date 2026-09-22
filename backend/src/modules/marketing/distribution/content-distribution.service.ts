import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { INITIABLE_CHANNEL_TYPES } from '../channels/outbound-conversation.service';
import { normalizeEmail, toE164 } from '../utils/lead-normalize';

/**
 * İçerik üretim hattı, aşama 4 — the distribution plan.
 *
 * ## The shape, and why it is this one
 *
 * The owner chose it explicitly and it is not a performance decision: **the
 * system produces a plan and drafts; a human sends.** The rejected alternative
 * was automated mass DMs to strangers, which is the exact pattern platform
 * spam detection exists to catch and how an account gets restricted. So this
 * service composes and STORES; it has no way to dispatch anything, and it does
 * not import the thing that can. See {@link DistributionSendService} for the
 * one send path and `distribution-send.boundary.spec.ts` for the assertion that
 * fails if a second one ever appears.
 *
 * ## Three parts, and the honest failure of each
 *
 * 1. **Cross-post** — every connected network the item is not already on, on a
 *    staggered schedule.
 * 2. **Tags** — the workspace's OWN connected accounts and its brand hashtags.
 * 3. **Outreach** — one prepared, unsent message per contactable lead.
 *
 * Every one of those can legitimately come back with nothing in it, and an
 * empty list is indistinguishable from "no distribution needed" — which is the
 * one thing this feature is forbidden to say. So a part that could not be
 * produced writes a `gap` with its reason, and the gaps travel inside the same
 * document as the plan, where no reader can render one without the other.
 *
 * ## The zero-accounts case is a REFUSAL, not a thin plan
 *
 * A workspace with nothing connected has nowhere to cross-post and nothing to
 * tag: two of the three parts are impossible, not empty. Handing back a
 * document titled "distribution plan" whose only content is "message these five
 * leads" would be the empty-reads-as-done failure wearing a plan's clothes. It
 * refuses, and the refusal names the fix.
 *
 * ## No AI call
 *
 * The draft copy is composed from the concept a human already approved and
 * already paid an Opus call for at planning time — the same argument
 * `ConceptPromotionService` makes for the post caption. A fresh generation here
 * would spend credits to say the same thing differently, on a message a human
 * is about to edit anyway.
 */

/** The item statuses a distribution plan may be produced for.
 *
 *  Approval is the floor rather than PUBLISHED because the plan is a
 *  PREPARATION — a cross-post schedule and a set of drafts are exactly what you
 *  want in hand before the video goes out, not after. Below approval there is
 *  no video anyone has agreed to promote. */
export const DISTRIBUTABLE_ITEM_STATUSES = ['APPROVED', 'SCHEDULED', 'PUBLISHED'] as const;

/**
 * How many people ONE video proposes contacting.
 *
 * A bound, not a page size. Without it a workspace with 40,000 leads gets 40,000
 * drafts from one approval — which is not a distribution plan, it is the mass
 * outreach the owner refused, merely queued behind a human who would rubber-stamp
 * it. Twenty-five is a number a person can actually read.
 */
export const OUTREACH_LIMIT = 25;

/**
 * Which channel outreach PREFERS when a lead is reachable on more than one.
 *
 * Explicit and stable, because merit ordering must decide WHICH MAILBOX, never
 * WHICH CHANNEL: taking whichever row the merit order happened to return first
 * would move a workspace's outreach off free email and onto paid, İYS-governed
 * SMS the first day somebody verifies an SMS channel — a spending decision
 * nobody made, arriving as a side effect of clicking Verify.
 *
 * Anything a conversation can be started on but that is not named here still
 * gets a turn, last: a new initiable channel must not drop out of outreach
 * silently just because this list was not updated with it.
 */
const OUTREACH_TYPE_PREFERENCE: readonly string[] = ['EMAIL', 'WHATSAPP', 'SMS'];

export const OUTREACH_TYPE_ORDER: readonly string[] = Object.freeze([
  ...OUTREACH_TYPE_PREFERENCE.filter((t) => INITIABLE_CHANNEL_TYPES.includes(t)),
  ...INITIABLE_CHANNEL_TYPES.filter((t) => !OUTREACH_TYPE_PREFERENCE.includes(t)),
]);

/**
 * Proven first, then the freshest proof, then the newest row — applied by the
 * database, since `nulls: 'last'` is the half a `desc` sort gets wrong on its
 * own (Postgres puts NULLs FIRST on DESC, so a mailbox nobody ever verified
 * would outrank every proven one).
 *
 * The same rule `WorkspaceMailboxService.bestChannelIds` applies, written out
 * here rather than called: this service is deliberately constructed with the
 * Prisma client and NOTHING else — `distribution-send.boundary.spec.ts` asserts
 * that arity — because an injectable graph is how a planner quietly acquires a
 * way to dispatch.
 *
 * NOT a `where lastVerifiedAt is not null` filter: verify is a manual button
 * and the consent (OAuth) connect path never stamps that column, so a hard
 * filter would silently zero out outreach for a workspace whose mailbox works.
 */
const BY_MERIT = [
  { lastVerifiedAt: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' },
] as const;

const DEFAULT_CROSS_POST_STAGGER_MS = 4 * 60 * 60 * 1000;

/**
 * Gap between one cross-post and the next. Simultaneous posting to every
 * network is itself a pattern platforms score as automation, and it wastes the
 * second and third audience on the same hour.
 *
 * The env value is VALIDATED rather than trusted, because the failure of a bare
 * `Number(...)` here is not a wrong number — it is a crash in a place nothing
 * would connect to a typo. `Number('4h')` is `NaN`, `NaN` propagates through
 * the `runAt` arithmetic, and `new Date(NaN).toISOString()` throws a
 * RangeError: every plan in the workspace, including the drafts and the tags
 * that have nothing to do with scheduling, fails with "Invalid time value".
 * A non-positive value is refused for the same reason it exists — a zero
 * stagger IS simultaneous posting.
 */
export const CROSS_POST_STAGGER_MS = (() => {
  const raw = process.env.DISTRIBUTION_CROSS_POST_STAGGER_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CROSS_POST_STAGGER_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Said out loud, not swallowed: the operator set this on purpose and the
    // whole point of falling back is that they must be able to find out it did
    // not take.
    new Logger('ContentDistributionConfig').warn(
      `DISTRIBUTION_CROSS_POST_STAGGER_MS="${raw}" is not a positive number of milliseconds; falling back to ${DEFAULT_CROSS_POST_STAGGER_MS}ms (4h).`,
    );
    return DEFAULT_CROSS_POST_STAGGER_MS;
  }
  return parsed;
})();

export type GapArea = 'crossPost' | 'tags' | 'outreach';

export interface PlanGap {
  area: GapArea;
  reason: string;
}

export interface CrossPost {
  network: string;
  socialAccountId: string;
  accountName: string;
  runAt: string;
  note: string;
}

export interface TaggableAccount {
  socialAccountId: string;
  network: string;
  displayName: string;
}

export interface DistributionPlanDocument {
  publishedNetworks: string[];
  crossPosts: CrossPost[];
  tags: { accounts: TaggableAccount[]; hashtags: string[] };
  outreachCount: number;
  /** Parts that could NOT be produced, each with its reason. Never omitted:
   *  an absent `gaps` key and an empty one must not be the same thing. */
  gaps: PlanGap[];
}

export interface DistributionPlanView {
  id: string;
  campaignItemId: string;
  plan: DistributionPlanDocument;
  /** The stored rows, verbatim. Not a projection: the panel needs `status`,
   *  `sentAt` and `error` to tell a waiting draft from a sent one from a failed
   *  one, and a hand-written subset is how one of those stops being returned. */
  drafts: DistributionDraftRow[];
}

/** One ACTIVE channel outreach may use — the merit winner of its type. */
interface OutreachChannel {
  id: string;
  type: string;
  name: string;
}

/** Shared, frozen: the two early returns of `outreach` mean "no channel at
 *  all", and a fresh Map per call would invite someone to write into one. */
const NO_CHANNELS: ReadonlyMap<string, OutreachChannel> = new Map();

/** What `outreach` decides before anything is written. Deliberately NOT the
 *  shape returned to callers — the persisted row is. */
interface PlannedDraft {
  leadId: string;
  channelType: string;
  channelId: string;
  toAddress: string;
}

type DistributionDraftRow = Awaited<
  ReturnType<PrismaService['distributionDraft']['findMany']>
>[number];

interface UsableAccount {
  id: string;
  network: string;
  displayName: string;
}

@Injectable()
export class ContentDistributionService {
  private readonly logger = new Logger(ContentDistributionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async plan(
    workspaceId: string,
    campaignItemId: string,
    createdById: string,
  ): Promise<DistributionPlanView> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: campaignItemId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        socialCampaignId: true,
        contentConceptId: true,
        socialPostId: true,
        status: true,
        topic: true,
      },
    });
    if (!item) {
      throw new NotFoundException(
        `Campaign item ${campaignItemId} does not exist in this workspace, so there is nothing to distribute.`,
      );
    }
    if (!(DISTRIBUTABLE_ITEM_STATUSES as readonly string[]).includes(item.status)) {
      throw new BadRequestException(
        `This item is ${item.status}. A distribution plan is only produced for an item at ${DISTRIBUTABLE_ITEM_STATUSES.join(', ')} — below that nobody has agreed to promote anything, and a plan would be scheduling cross-posts for a video that may never exist.`,
      );
    }

    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId },
      select: {
        id: true,
        network: true,
        displayName: true,
        enabled: true,
        lastError: true,
        tokenExpiresAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const usable = this.usableAccounts(accounts);

    // The cold-start refusal. Two of the three parts of a plan are IMPOSSIBLE
    // without a connected account, not merely empty, and a document called a
    // distribution plan that quietly omits both would read as "nothing to do".
    if (!accounts.length) {
      throw new BadRequestException(
        'This workspace has no connected social account, so there is nowhere to cross-post this video and no account to tag. Connect one first (Settings → Connections). This is a missing connection, not an absence of distribution work.',
      );
    }
    if (!usable.length) {
      const names = accounts.map((a) => a.displayName).join(', ');
      throw new BadRequestException(
        `Every connected account needs reconnecting (${names}) — each is disabled, expired, or reporting an error, so nothing can be cross-posted or tagged. Reconnect one first (Settings → Connections). This is a broken connection, not an absence of distribution work.`,
      );
    }

    const gaps: PlanGap[] = [];
    const publishedNetworks = await this.publishedNetworks(workspaceId, item.socialPostId);
    const crossPosts = this.crossPosts(usable, publishedNetworks, gaps);
    const tags = await this.tags(workspaceId, usable, gaps);
    const { drafts, body, channels } = await this.outreach(workspaceId, item, gaps);

    const document: DistributionPlanDocument = {
      publishedNetworks,
      crossPosts,
      tags,
      outreachCount: drafts.length,
      gaps,
    };

    // Upsert on the item, not create: re-planning REPLACES the document and
    // keeps the plan's identity, so a draft a human already sent keeps pointing
    // at a row that still exists.
    const row = await this.prisma.contentDistributionPlan.upsert({
      where: { campaignItemId: item.id },
      create: {
        workspaceId,
        campaignItemId: item.id,
        socialCampaignId: item.socialCampaignId,
        contentConceptId: item.contentConceptId,
        plan: document as unknown as Prisma.InputJsonValue,
        createdById,
      },
      update: { plan: document as unknown as Prisma.InputJsonValue },
      select: { id: true },
    });

    if (drafts.length) {
      // skipDuplicates against the (planId, leadId, channelType) unique index:
      // re-planning must not stack a second copy of a message beside one a human
      // has already read or edited. The index is the guarantee — a
      // read-then-create guard cannot stop two concurrent runs both inserting.
      await this.prisma.distributionDraft.createMany({
        data: drafts.map((d) => ({
          workspaceId,
          planId: row.id,
          campaignItemId: item.id,
          leadId: d.leadId,
          channelType: d.channelType,
          channelId: d.channelId,
          toAddress: d.toAddress,
          body,
          status: 'DRAFT' as const,
        })),
        skipDuplicates: true,
      });
    }

    await this.repairRouting(workspaceId, row.id, channels);

    return this.view(workspaceId, row.id, item.id, document);
  }

  /**
   * Re-planning repairs the ROUTE of a draft nobody has sent yet.
   *
   * `createMany(..., { skipDuplicates: true })` against
   * `@@unique([planId, leadId, channelType])` silently skips every draft that
   * already exists, and nothing in this feature deletes drafts — `dismissDraft`
   * flips a status. So the `channelId` frozen into a row at plan time could
   * never be corrected, and re-planning — the one thing an operator would try
   * after a run of `535 Authentication Failed` — changed nothing at all. That
   * is the half of this that actually reaches an existing workspace.
   *
   * Scoped to the rows that can still be sent. A SENT row is the record of
   * where a message actually went, and a DISMISSED one was a decision; neither
   * is a route waiting to be corrected.
   *
   * Only the channel. `toAddress` is display copy — the send path re-derives
   * the address from the lead — and rewriting it would need one statement per
   * draft rather than one per type.
   */
  private async repairRouting(
    workspaceId: string,
    planId: string,
    channels: ReadonlyMap<string, OutreachChannel>,
  ): Promise<void> {
    for (const [type, channel] of channels) {
      await this.prisma.distributionDraft.updateMany({
        where: {
          workspaceId,
          planId,
          channelType: type,
          status: { in: ['DRAFT', 'FAILED'] },
          channelId: { not: channel.id },
        },
        data: { channelId: channel.id },
      });
    }
  }

  /** The stored plan, or an explicit 404 — never a synthesised empty one, which
   *  would read as "we looked and there is nothing to distribute". */
  async get(workspaceId: string, campaignItemId: string): Promise<DistributionPlanView> {
    const row = await this.prisma.contentDistributionPlan.findFirst({
      where: { campaignItemId, workspaceId },
      select: { id: true, campaignItemId: true, plan: true },
    });
    if (!row) {
      throw new NotFoundException(
        `No distribution plan has been produced for campaign item ${campaignItemId} yet. Produce one first — this is "not planned", not "nothing to distribute".`,
      );
    }
    return this.view(
      workspaceId,
      row.id,
      row.campaignItemId,
      row.plan as unknown as DistributionPlanDocument,
    );
  }

  /** Everything still waiting for a person, for one plan or the whole
   *  workspace. */
  listDrafts(workspaceId: string, filter: { planId?: string; status?: string } = {}) {
    return this.prisma.distributionDraft.findMany({
      where: {
        workspaceId,
        ...(filter.planId ? { planId: filter.planId } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  /**
   * A draft a human decided NOT to send.
   *
   * Deliberately part of THIS service and not the send service: dismissing
   * dispatches nothing, and putting it beside `send` would give the file that
   * owns the send boundary a second reason to exist.
   */
  async dismissDraft(workspaceId: string, draftId: string) {
    const claimed = await this.prisma.distributionDraft.updateMany({
      where: { id: draftId, workspaceId, status: 'DRAFT' },
      data: { status: 'DISMISSED' },
    });
    if (!claimed.count) {
      throw new NotFoundException(
        `Draft ${draftId} is not a pending draft in this workspace — it may already have been sent or dismissed.`,
      );
    }
    return this.prisma.distributionDraft.findFirst({ where: { id: draftId, workspaceId } });
  }

  // ————————————————————————————————————————————————————————————————

  /** Connected AND actually usable. `needsReconnect` is the same three-part
   *  test `jeeta.list_social_accounts` projects, kept identical so the plan and
   *  the account list cannot disagree about who is connected. */
  private usableAccounts(
    accounts: Array<{
      id: string;
      network: string;
      displayName: string;
      enabled: boolean;
      lastError: string | null;
      tokenExpiresAt: Date | null;
    }>,
  ): UsableAccount[] {
    const now = Date.now();
    return accounts
      .filter(
        (a) =>
          a.enabled &&
          !a.lastError &&
          (!a.tokenExpiresAt || a.tokenExpiresAt.getTime() > now),
      )
      .map((a) => ({ id: a.id, network: a.network, displayName: a.displayName }));
  }

  private async publishedNetworks(workspaceId: string, socialPostId: string | null) {
    if (!socialPostId) return [];
    const targets = await this.prisma.socialPostTarget.findMany({
      where: { workspaceId, postId: socialPostId, status: 'PUBLISHED' },
      select: { network: true },
    });
    return [...new Set(targets.map((t) => t.network))];
  }

  private crossPosts(
    usable: UsableAccount[],
    publishedNetworks: string[],
    gaps: PlanGap[],
  ): CrossPost[] {
    const already = new Set(publishedNetworks);
    const targets = usable.filter((a) => !already.has(a.network));
    if (!targets.length) {
      gaps.push({
        area: 'crossPost',
        reason:
          'This video is already published on every network this workspace has connected, so there is no other timeline to redirect from. Connect another network to widen it.',
      });
      return [];
    }
    const base = Date.now();
    return targets.map((a, i) => ({
      network: a.network,
      socialAccountId: a.id,
      accountName: a.displayName,
      runAt: new Date(base + (i + 1) * CROSS_POST_STAGGER_MS).toISOString(),
      note: already.size
        ? `Cross-post to ${a.network} and point it back at the original ${[...already].join('/')} post.`
        : `Post to ${a.network}.`,
    }));
  }

  private async tags(workspaceId: string, usable: UsableAccount[], gaps: PlanGap[]) {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      select: { defaultHashtags: true },
    });
    const hashtags = kit?.defaultHashtags ?? [];
    if (!hashtags.length) {
      gaps.push({
        area: 'tags',
        reason:
          'No hashtags are set on the brand kit, so none are proposed. Set them once in Brand → Brand Kit and every plan after this will carry them.',
      });
    }
    // Stated on EVERY plan, not only when something is missing: it is a
    // permanent property of the data, and a reader who does not see it will
    // assume the empty list means "nobody worth tagging".
    gaps.push({
      area: 'tags',
      reason:
        'Only this workspace’s own connected accounts are proposed. No third-party handle is suggested, because nothing in this product stores one — inventing a handle would produce a tag that either does not exist or belongs to someone else.',
    });
    return {
      accounts: usable.map((a) => ({
        socialAccountId: a.id,
        network: a.network,
        displayName: a.displayName,
      })),
      hashtags,
    };
  }

  /**
   * The people to contact, and the message prepared for each.
   *
   * Channels are limited to what `OutboundConversationService` can actually
   * START a conversation on — imported from that file rather than re-listed, so
   * the plan and the send path cannot drift apart about which platforms permit
   * a first move.
   */
  private async outreach(
    workspaceId: string,
    item: {
      id: string;
      contentConceptId: string | null;
      socialPostId: string | null;
      topic: string | null;
    },
    gaps: PlanGap[],
  ) {
    const body = await this.draftBody(workspaceId, item);
    if (!body) {
      gaps.push({
        area: 'outreach',
        reason:
          'No copy could be found for this item — it carries no approved concept, no post content and no topic — so no message could be composed. That is a missing-content failure, not a decision that nobody should be told.',
      });
      return { drafts: [], body: '', channels: NO_CHANNELS };
    }

    const rows = await this.prisma.channel.findMany({
      where: { workspaceId, status: 'ACTIVE', type: { in: [...INITIABLE_CHANNEL_TYPES] } },
      select: { id: true, type: true, name: true },
      orderBy: [...BY_MERIT],
    });
    // The best row of each type, not the best row overall: the type is chosen
    // by OUTREACH_TYPE_ORDER below, merit only decides which mailbox of that
    // type carries it.
    const channels = new Map<string, OutreachChannel>();
    for (const ch of rows) if (!channels.has(ch.type)) channels.set(ch.type, ch);
    if (!channels.size) {
      gaps.push({
        area: 'outreach',
        reason: `No active channel this workspace has can START a conversation. Only ${INITIABLE_CHANNEL_TYPES.join(', ')} can — Instagram, Messenger and TikTok only permit replying to someone who wrote first, which is the platforms' rule and not a missing integration. Connect one of the three to prepare outreach drafts.`,
      });
      return { drafts: [], body, channels: NO_CHANNELS };
    }

    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, deletedAt: null, mergedIntoId: null },
      select: {
        id: true,
        phone: true,
        whatsapp: true,
        email: true,
        emailOptOut: true,
        smsOptOut: true,
        waOptOut: true,
        emailVerifiedStatus: true,
        emailBouncedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: OUTREACH_LIMIT,
    });

    const drafts: PlannedDraft[] = [];
    for (const lead of leads) {
      const match = this.reachOn(channels, lead);
      if (!match) continue;
      drafts.push({
        leadId: lead.id,
        channelType: match.channel.type,
        channelId: match.channel.id,
        toAddress: match.address,
      });
    }

    if (!drafts.length) {
      gaps.push({
        area: 'outreach',
        reason: leads.length
          ? `None of the ${leads.length} most recently updated people can be contacted about this: each has opted out, has no address on a channel that can start a conversation, or has an email address that has bounced or failed verification. That is a reachability problem, not a decision that nobody should be told.`
          : 'This workspace has no contactable people on file yet, so no outreach draft could be prepared. Import or capture some first.',
      });
    } else if (leads.length === OUTREACH_LIMIT) {
      gaps.push({
        area: 'outreach',
        reason: `Only the ${OUTREACH_LIMIT} most recently updated people were considered. This is a cap on purpose — one approval must not turn into thousands of messages waiting behind a single click.`,
      });
    }

    return { drafts, body, channels };
  }

  /**
   * The first channel this lead is genuinely reachable on, applying the SAME
   * three gates the send path applies at send time: opt-out, email hygiene,
   * and an address that exists.
   *
   * Applied here as well as there deliberately. The send path is the authority
   * and will refuse again; the point of repeating it is that a draft a human
   * reads should not be a message that will be rejected the moment they click —
   * an outreach list full of people who cannot be contacted is worse than a
   * short one.
   *
   * It walks OUTREACH_TYPE_ORDER, never the rows: which channel TYPE we reach
   * someone on is a standing decision about what outreach costs, and it must
   * not change because a row was verified or created yesterday.
   */
  private reachOn(
    channels: ReadonlyMap<string, OutreachChannel>,
    lead: {
      phone: string | null;
      whatsapp: string | null;
      email: string | null;
      emailOptOut: boolean;
      smsOptOut: boolean;
      waOptOut: boolean;
      emailVerifiedStatus: string | null;
      emailBouncedAt: Date | null;
    },
  ): { channel: OutreachChannel; address: string } | null {
    // Only the types a conversation can be STARTED on are in the order, and the
    // map is keyed by type, so a channel nobody can open a thread on cannot be
    // reached from here at all — it is structure now, not a check.
    for (const type of OUTREACH_TYPE_ORDER) {
      const channel = channels.get(type);
      if (!channel) continue;
      if (channel.type === 'EMAIL') {
        if (lead.emailOptOut) continue;
        if (lead.emailBouncedAt || lead.emailVerifiedStatus === 'INVALID') continue;
        if (!lead.email) continue;
        return { channel, address: normalizeEmail(lead.email) };
      }
      if (channel.type === 'SMS') {
        if (lead.smsOptOut || !lead.phone) continue;
        const e164 = toE164(lead.phone);
        if (!e164) continue;
        return { channel, address: e164 };
      }
      if (channel.type === 'WHATSAPP') {
        if (lead.waOptOut) continue;
        const raw = lead.whatsapp ?? lead.phone;
        if (!raw) continue;
        const e164 = toE164(raw);
        if (!e164) continue;
        return { channel, address: e164 };
      }
    }
    return null;
  }

  /** The words, from the work already done and already paid for. */
  private async draftBody(
    workspaceId: string,
    item: { contentConceptId: string | null; socialPostId: string | null; topic: string | null },
  ): Promise<string> {
    if (item.contentConceptId) {
      const concept = await this.prisma.contentConcept.findFirst({
        where: { id: item.contentConceptId, workspaceId },
        select: { hook: true, title: true, shotPlan: true },
      });
      if (concept) {
        const caption = (concept.shotPlan as { captionSuggestion?: unknown } | null)
          ?.captionSuggestion;
        return [concept.hook, typeof caption === 'string' && caption ? caption : concept.title]
          .filter(Boolean)
          .join('\n\n');
      }
    }
    if (item.socialPostId) {
      const post = await this.prisma.socialPost.findFirst({
        where: { id: item.socialPostId, workspaceId },
        select: { content: true },
      });
      if (post?.content?.trim()) return post.content.trim();
    }
    return item.topic?.trim() ?? '';
  }

  private async view(
    workspaceId: string,
    planId: string,
    campaignItemId: string,
    document: DistributionPlanDocument,
  ): Promise<DistributionPlanView> {
    const drafts = await this.prisma.distributionDraft.findMany({
      where: { workspaceId, planId },
      orderBy: { createdAt: 'asc' },
    });
    return { id: planId, campaignItemId, plan: document, drafts };
  }
}
