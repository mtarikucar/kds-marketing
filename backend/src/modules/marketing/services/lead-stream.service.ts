import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { salesCallIdOf } from '../telephony/call-activity';

/**
 * Per-source row cap.
 *
 * Same reasoning as `home-timeline.service.ts`, one difference. There the cut
 * falls on the EARLIEST rows of a bounded window; here the window is a whole
 * relationship with no end date, so each source is read NEWEST-first and the
 * cut falls on the OLDEST rows. A stream that hid today's messages to make
 * room for last year's would be worse than no stream at all — `thread()` in
 * conversations.service.ts already learned this the hard way (its comment
 * records an agent replying with no view of the latest customer message).
 *
 * Each query asks for `CAP + 1` and reports truncation at `> CAP`. Asking for
 * exactly CAP would leave "200 rows with more behind them" and "200 rows and
 * that was all" indistinguishable.
 */
export const CAP = 200;

/**
 * The user-facing name of each source, in one place. `unread`, `truncated` and
 * `gated` all report by name, and the same source drifting into two names
 * across three lists would be its own small lie.
 */
const SOURCE = {
  messages: 'mesajlar',
  activities: 'hareketler',
  authors: 'yazarlar',
} as const;

/**
 * How an item should read, not what table it came from.
 *
 * `message` is one source; the other four are all LeadActivity rows, split
 * because a logged call, a note, a status move and everything else are four
 * different things to look at. The raw `LeadActivity.type` rides along in
 * `activityType` so nothing is lost in the mapping — a new activity type
 * added tomorrow lands in `activity` with its own name intact rather than
 * disappearing.
 */
export type LeadStreamKind = 'message' | 'call' | 'note' | 'status' | 'activity';

export interface LeadStreamItem {
  kind: LeadStreamKind;
  /** Row id. Message ids and activity ids share no space; `kind` separates them. */
  id: string;
  /** ISO 8601. */
  at: string;
  /** The activity's title. Null on a message: a message's content is its body. */
  title: string | null;
  /** Message body, or the activity's description. */
  body: string | null;

  // ── messages only (null on every activity) ───────────────────────────────
  direction: 'INBOUND' | 'OUTBOUND' | null;
  authorType: 'CUSTOMER' | 'AI' | 'AGENT' | 'SYSTEM' | null;
  conversationId: string | null;
  channelId: string | null;
  channelType: string | null;
  /** RECEIVED | SENT | DELIVERED | READ | FAILED. A FAILED message must never
   *  be rendered as delivered — the surface's existing rule. */
  deliveryStatus: string | null;
  /** Provider/adapter error on a FAILED message. */
  error: string | null;
  /**
   * `Message.meta`, verbatim. The provider payload is the ONLY thing marking
   * an inbound row as a voicemail or a fax (`meta.raw.kind`) and the only
   * place its audio/document link lives — a Message has no channel column of
   * its own. Passed through rather than parsed here so this service does not
   * become a second place where NetGSM's payload shape is spelled out.
   */
  meta: unknown | null;

  // ── activities only (null on every message) ──────────────────────────────
  activityType: string | null;
  outcome: string | null;
  durationMinutes: number | null;
  /**
   * How an assignment happened, when the activity IS one.
   *
   * `LeadActivity.metadata` distinguishes an auto-distribution on ingest from
   * a manager's bulk assign from a single manual reassignment; the title does
   * not — three of the four shapes are STATUS_CHANGE rows whose prose starts
   * with the same word. The lead detail's old timeline badged them apart, and
   * that badge died with it when Hareketler became Akış.
   *
   * A narrow enum rather than the raw `metadata` blob: this is the one thing
   * a reader needs, and shipping the blob would put user ids and names on a
   * DTO that has no other reason to carry them.
   */
  assignment: 'auto' | 'bulk' | 'manual' | null;
  /**
   * The `SalesCall` a logged call mirrors, when the row knows one.
   *
   * A call row without it is a dead end: the recording and the AI analysis
   * both hang off a `SalesCall.id`, so a reader could see "Sales call:
   * CONNECTED · 3 dk" and had to leave for /calls and find the row again by
   * phone number and timestamp to hear it.
   *
   * Null on every other kind, and null on every call MIRRORED BEFORE the id
   * was carried — there is no backfill (see call-activity.ts), and the caller
   * is expected to render those exactly as it does today rather than as a
   * broken player.
   *
   * A derived field, like `assignment` beside it, rather than the raw
   * `metadata` blob: this is the one thing a reader needs, and shipping the
   * blob would put user ids and names on a DTO that has no other reason to
   * carry them.
   */
  callId: string | null;

  // ── both, when there is a person behind it ───────────────────────────────
  /** MarketingUser id: the AGENT who sent the message, or the activity's author. */
  authorId: string | null;
  /** Resolved display name; null for a customer, an AI, or an unknown id. */
  authorName: string | null;
}

export interface LeadStream {
  leadId: string;
  /** Oldest → newest, the order a conversation renders in. */
  items: LeadStreamItem[];
  /** Sources that could not be READ, by name. Empty when both answered. */
  unread: string[];
  /**
   * Sources with more rows than were returned, by name. What came back is the
   * NEWEST `CAP` of them (see CAP).
   *
   * Deliberately NOT merged into `unread`: "could not read this source" and
   * "read it, there was more" are different failures needing different fixes.
   */
  truncated: string[];
  /**
   * Sources WITHHELD by the workspace's plan, by name. A third list rather
   * than a third meaning stapled onto `unread`, because nothing failed here:
   * the conversation column is sold separately (`conversationAi`), and the
   * design is explicit that a workspace without it still sees the person and
   * their activities. Telling a customer their messages "could not be read"
   * when the truth is "your plan does not include them" sends them to support
   * instead of to billing.
   */
  gated: string[];
}

/**
 * ONE stream per person: messages and lead activities on a single time axis.
 *
 * This exists because the merged surface treats the person as the object and a
 * conversation as one of their fields. Two lists from two endpoints is what
 * made v2.283.0's merge cosmetic.
 *
 * Modelled on `home-timeline.service.ts`, and it keeps that file's two load-
 * bearing ideas: a source that fails NAMES itself rather than shrinking the
 * list, and the `CAP + 1` cut is applied at the MAPPING site so a source added
 * later cannot silently skip truncation detection.
 *
 * Tenant scope, stated because two of the three reads cannot rely on a foreign
 * key: the lead is resolved by `(id, workspaceId)` first and everything else
 * hangs off that resolution. `conversations` has no key to `leads`, so its
 * read carries `workspaceId` itself — without it a neighbour's thread naming
 * one of our lead ids would pour into this stream. `lead_activities` has no
 * `workspaceId` column at all, so its read reaches the tenant through the
 * relation filter `lead: { workspaceId }` rather than through `leadId` alone.
 */
@Injectable()
export class LeadStreamService {
  private readonly logger = new Logger(LeadStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async forLead(
    workspaceId: string,
    leadId: string,
    userId: string,
    userRole: string,
  ): Promise<LeadStream> {
    // Resolve the person FIRST, scoped. A lead id from another workspace stops
    // here — every read below is derived from a lead that is provably ours.
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { id: true, assignedToId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    // Mirrors MarketingLeadsService.findOne: a REP's stream is their own
    // people's. One rule, two places, same wording.
    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only view your own leads');
    }

    const unread: string[] = [];
    const gated: string[] = [];
    const soft =
      <T>(label: string, fallback: T) =>
      (e: unknown): T => {
        unread.push(label);
        this.logger.warn(
          `lead stream source "${label}" failed for ${workspaceId}/${leadId}: ${
            e instanceof Error ? e.message : e
          }`,
        );
        return fallback;
      };

    // The conversation column is sold separately. Read the SAME entitlement
    // FeatureGuard reads, so the gate cannot drift between the two.
    const conversationsAllowed = await this.entitlements
      .getEffective(workspaceId)
      .then((e) => e.features.conversationAi)
      // An entitlement lookup that THREW is not a "no" — refusing to show a
      // paying customer their messages because billing hiccuped would be the
      // same silent lie in the other direction. It is a failed source.
      .catch(soft(SOURCE.messages, null as boolean | null));

    if (conversationsAllowed === false) gated.push(SOURCE.messages);

    const [messages, activities] = await Promise.all([
      conversationsAllowed === true
        ? this.readMessages(workspaceId, leadId).catch(soft(SOURCE.messages, EMPTY_MESSAGES))
        : Promise.resolve(EMPTY_MESSAGES),
      this.prisma.leadActivity
        .findMany({
          // `leadId` alone would be enough here (LeadActivity DOES have a real
          // foreign key to Lead, and `lead` was resolved in-workspace above),
          // but the relation filter says the tenant rule out loud in the query
          // rather than leaving it as an argument about a check ten lines up.
          where: { leadId, lead: { workspaceId } },
          select: {
            id: true,
            type: true,
            title: true,
            description: true,
            outcome: true,
            duration: true,
            metadata: true,
            createdById: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: CAP + 1,
        })
        .catch(soft(SOURCE.activities, [] as Array<Record<string, never>> as any)),
    ]);

    const truncated: string[] = [];
    /**
     * Trim a source to the cap and report it in the same breath, at the point
     * the source is mapped rather than from a table beside it — a table is a
     * place to forget, and forgetting it means that source can never report
     * truncation: no type error, no failing test, exactly the silence this
     * file exists to prevent.
     *
     * A source that FAILED fell back to an empty list, so it can never land in
     * both lists: it is unread, not truncated.
     */
    const cut = <T>(label: string, rows: T[]): T[] => {
      if (rows.length > CAP) truncated.push(label);
      return rows.slice(0, CAP);
    };

    const msgRows = cut(SOURCE.messages, messages.rows);
    const actRows = cut(SOURCE.activities, activities);

    // One lookup for every name the two sources need. Soft, and named: a
    // stream with blank authors is worth more than no stream, but a reader has
    // to be able to tell "nobody wrote this" from "we could not say who did".
    const authorIds = [
      ...new Set(
        [...msgRows.map((m) => m.authorId), ...actRows.map((a: any) => a.createdById)].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const authors = authorIds.length
      ? await this.prisma.marketingUser
          .findMany({
            where: { workspaceId, id: { in: authorIds } },
            select: { id: true, firstName: true, lastName: true },
          })
          .catch(soft(SOURCE.authors, [] as Array<{ id: string; firstName: string; lastName: string }>))
      : [];
    const nameById = new Map(
      authors.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || null]),
    );

    const items: LeadStreamItem[] = [
      ...msgRows.map((m) => ({
        ...BLANK,
        kind: 'message' as const,
        id: m.id,
        at: m.createdAt.toISOString(),
        body: m.body,
        direction: m.direction as LeadStreamItem['direction'],
        authorType: m.authorType as LeadStreamItem['authorType'],
        conversationId: m.conversationId,
        channelId: messages.channelByConvo.get(m.conversationId)?.id ?? null,
        channelType: messages.channelByConvo.get(m.conversationId)?.type ?? null,
        deliveryStatus: m.status,
        error: m.error,
        meta: m.meta ?? null,
        authorId: m.authorId,
        authorName: m.authorId ? (nameById.get(m.authorId) ?? null) : null,
      })),
      ...actRows.map((a: any) => ({
        ...BLANK,
        kind: kindOfActivity(a.type),
        id: a.id,
        at: a.createdAt.toISOString(),
        title: a.title,
        body: a.description ?? null,
        activityType: a.type,
        outcome: a.outcome ?? null,
        durationMinutes: a.duration ?? null,
        assignment: assignmentOf(a.metadata),
        callId: salesCallIdOf(a.metadata),
        authorId: a.createdById ?? null,
        authorName: a.createdById ? (nameById.get(a.createdById) ?? null) : null,
      })),
      // Oldest first: this renders as a conversation, and a conversation reads
      // downwards. Ties break on id so two events in the same millisecond do
      // not swap places between two loads of the same page.
    ].sort((x, y) => (x.at === y.at ? x.id.localeCompare(y.id) : x.at.localeCompare(y.at)));

    return {
      leadId,
      items,
      // `unread` is sorted because `soft` appends from inside `.catch`, so its
      // push order follows whichever query rejected first — two failures would
      // swap places between refreshes and read as a bug in the list itself.
      // The other two are already deterministic; they are sorted only so all
      // three lists read alike.
      unread: [...new Set(unread)].sort(),
      truncated: truncated.sort(),
      gated: gated.sort(),
    };
  }

  /**
   * The message source: the person's threads, then their messages, then the
   * channels those threads run on — one unit, because a failure in any of the
   * three means the same thing to a reader ("we could not show the messages")
   * and should be named once rather than three times.
   */
  private async readMessages(workspaceId: string, leadId: string) {
    const convos = await this.prisma.conversation.findMany({
      // `workspaceId` is NOT redundant beside `leadId`. There is no foreign key
      // from conversations to leads, so a row in another workspace may legally
      // name this lead id; the e2e keeps exactly such a row around.
      where: { workspaceId, leadId },
      select: { id: true, channelId: true },
    });
    const convoIds = convos.map((c) => c.id);
    if (convoIds.length === 0) {
      return { rows: [] as MessageRow[], channelByConvo: new Map<string, ChannelRef>() };
    }

    const [rows, channels] = await Promise.all([
      this.prisma.message.findMany({
        where: { workspaceId, conversationId: { in: convoIds } },
        select: {
          id: true,
          conversationId: true,
          direction: true,
          authorType: true,
          authorId: true,
          body: true,
          status: true,
          error: true,
          meta: true,
          createdAt: true,
        },
        // Newest first, so the cap drops the OLDEST rows (see CAP).
        orderBy: { createdAt: 'desc' },
        take: CAP + 1,
      }),
      this.prisma.channel.findMany({
        where: { workspaceId, id: { in: [...new Set(convos.map((c) => c.channelId))] } },
        select: { id: true, type: true },
      }),
    ]);

    const channelById = new Map(channels.map((c) => [c.id, c]));
    const channelByConvo = new Map<string, ChannelRef>();
    for (const c of convos) {
      const ch = channelById.get(c.channelId);
      if (ch) channelByConvo.set(c.id, ch);
    }
    return { rows, channelByConvo };
  }
}

interface ChannelRef {
  id: string;
  type: string;
}

interface MessageRow {
  id: string;
  conversationId: string;
  direction: string;
  authorType: string;
  authorId: string | null;
  body: string;
  status: string;
  error: string | null;
  meta: unknown | null;
  createdAt: Date;
}

const EMPTY_MESSAGES: { rows: MessageRow[]; channelByConvo: Map<string, ChannelRef> } = {
  rows: [],
  channelByConvo: new Map(),
};

/**
 * Every optional field, explicitly null.
 *
 * Spread over each item so a message carries `outcome: null` rather than no
 * `outcome` at all. `undefined` disappears in JSON, and a field that is
 * sometimes absent forces every consumer to guess whether it is missing
 * because the value is empty or because this kind never has one.
 */
const BLANK = {
  title: null as string | null,
  body: null as string | null,
  direction: null as LeadStreamItem['direction'],
  authorType: null as LeadStreamItem['authorType'],
  conversationId: null as string | null,
  channelId: null as string | null,
  channelType: null as string | null,
  deliveryStatus: null as string | null,
  error: null as string | null,
  meta: null as unknown | null,
  activityType: null as string | null,
  outcome: null as string | null,
  durationMinutes: null as number | null,
  assignment: null as LeadStreamItem['assignment'],
  callId: null as string | null,
  authorId: null as string | null,
  authorName: null as string | null,
};

/** LeadActivity.type → how the item should read. Unknown types keep their name
 *  in `activityType` and render generically rather than vanishing. */
/**
 * `LeadActivity.metadata` -> how the assignment happened.
 *
 * Three writers set this shape and each sets ONE discriminator:
 * marketing-leads-ingest.service.ts stamps `auto: true`, the bulk path in
 * marketing-leads.service.ts stamps `bulk: true`, and the single-lead assign
 * path stamps neither. Everything without `kind: 'assignment'` — every legacy
 * row, every ordinary stage move — is not an assignment and answers null, so
 * the badge cannot appear on a plain STATUS_CHANGE.
 */
export function assignmentOf(metadata: unknown): LeadStreamItem['assignment'] {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  if (m.kind !== 'assignment') return null;
  if (m.auto === true) return 'auto';
  if (m.bulk === true) return 'bulk';
  return 'manual';
}

function kindOfActivity(type: string): LeadStreamKind {
  if (type === 'CALL') return 'call';
  if (type === 'NOTE') return 'note';
  if (type === 'STATUS_CHANGE') return 'status';
  return 'activity';
}
