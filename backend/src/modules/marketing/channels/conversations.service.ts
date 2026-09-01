import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingNotificationsService } from '../services/marketing-notifications.service';
import { MessageSenderService } from './message-sender.service';
import { ConversationStreamService } from './conversation-stream.service';

export interface ConversationListFilters {
  status?: string;
  channelId?: string;
  assignedToId?: string;
  /** Narrow the inbox to one lead's threads (the lead detail page's feed). */
  leadId?: string;
  limit?: number;
}

/**
 * The agent Inbox surface: list threads, read a thread, reply (which pauses
 * the AI — a human has taken over), (re)assign, open/close, and toggle the AI
 * pause. All reads/writes are workspace-scoped; single-row mutations resolve
 * the id through a scoped read first.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: MessageSenderService,
    private readonly stream: ConversationStreamService,
    private readonly notifications: MarketingNotificationsService,
  ) {}

  /**
   * Resolve an assignee against the workspace's MEMBERSHIP, which is the source
   * of truth for who belongs here and whether they are still active.
   *
   * Both assign paths used to read `MarketingUser {id, workspaceId}` instead.
   * That mirror is stamped when the user row is created and never re-derived,
   * so it fails in both directions: a teammate who joined this workspace by
   * membership but was created in another one is rejected outright — you
   * cannot hand them a thread at all — while someone whose membership was
   * revoked still passes, because their user row keeps the old workspaceId.
   * (Prod already has a membership whose user's home workspace differs.)
   *
   * Neither path checked STATUS at all, so a deactivated member could be handed
   * live customer conversations: the thread leaves the unassigned queue and
   * lands with someone who cannot log in, while the customer waits.
   *
   * Unlike a LEAD (REP-only, because conversion stamps a commission), a
   * conversation may go to any ACTIVE member — owners and managers work the
   * inbox too.
   */
  private async assertActiveMember(workspaceId: string, userId: string): Promise<void> {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { userId, workspaceId },
      select: { status: true },
    });
    if (!membership) throw new NotFoundException('Assignee not found');
    if (membership.status !== 'ACTIVE') {
      throw new BadRequestException('Assignee is not an active member of this workspace');
    }
  }

  /**
   * Tell the assignee a thread is now theirs. Lead assignment and task
   * assignment both notify; the inbox — where a customer is actually waiting on
   * the other end — was the one assignment verb that stayed silent, so a
   * handed-off thread sat unseen until someone happened to open the inbox and
   * filter by themselves. Best-effort: the assignment is the delivery, and a
   * notification failure must not undo it.
   */
  private async notifyAssignee(
    workspaceId: string,
    conversationId: string,
    userId: string,
    leadId: string,
  ): Promise<void> {
    await this.notifications
      .create({
        workspaceId,
        userId,
        type: 'CONVERSATION_ASSIGNED',
        title: 'A conversation was assigned to you',
        message: 'A customer conversation is now waiting for your reply.',
        // The inbox selects a person in React state, so a conversationId has no
        // URL to open. leadId (non-nullable on Conversation) does, and it is
        // what the bell routes on.
        metadata: { conversationId, leadId, source: 'inbox' },
      })
      .catch((e) =>
        this.logger.warn(
          `conversation ${conversationId}: assignee notification failed: ${(e as Error)?.message ?? e}`,
        ),
      );
  }

  async list(workspaceId: string, filters: ConversationListFilters = {}) {
    const convos = await this.prisma.conversation.findMany({
      where: {
        workspaceId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.channelId ? { channelId: filters.channelId } : {}),
        ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
        ...(filters.leadId ? { leadId: filters.leadId } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: Math.min(filters.limit ?? 50, 100),
    });
    return this.enrich(workspaceId, convos);
  }

  async thread(workspaceId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    const [messages, lead, channel] = await Promise.all([
      // Take the most RECENT 500 messages, not the oldest 500 — a long-running
      // thread (>500 messages) would otherwise show ancient history and HIDE the
      // latest customer message, so an agent replies with no view of it. Fetched
      // desc, reversed below to the chronological order the thread renders in.
      this.prisma.message.findMany({
        where: { workspaceId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.lead.findFirst({
        where: { id: convo.leadId, workspaceId },
        select: {
          id: true,
          businessName: true,
          contactPerson: true,
          phone: true,
          email: true,
          status: true,
          assignedToId: true,
        },
      }),
      this.prisma.channel.findFirst({
        where: { id: convo.channelId, workspaceId },
        select: { id: true, type: true, name: true, agentProfileId: true },
      }),
    ]);
    // Reverse the desc-fetched recent window back to chronological (oldest→newest).
    return { conversation: convo, messages: messages.reverse(), lead, channel };
  }

  /** Agent reply — a human takeover, so the AI is paused for this thread. */
  async reply(workspaceId: string, conversationId: string, text: string, agentUserId: string) {
    return this.sendTakeoverReply(workspaceId, conversationId, text, {
      authorType: 'AGENT',
      authorId: agentUserId,
    });
  }

  /**
   * Reply sent by Claude through the MCP connector (`jeeta.send_message`).
   * An API-key MCP session carries no human user — inventing a synthetic
   * agent id to pass through `reply()` would misattribute a real
   * customer-facing message to a person who never wrote it. This message
   * genuinely IS AI-authored, so it is persisted that way: `authorType:
   * 'AI'`, `authorId: null` (nullable on `Message`, and 'AI' is already a
   * value this codebase writes — see `conversation-ai-engine.service.ts`).
   *
   * Phase 3 (OAuth) will carry a real authenticated user through MCP and can
   * attribute these replies to that person via `reply()` instead.
   */
  async replyAsAi(workspaceId: string, conversationId: string, text: string) {
    return this.sendTakeoverReply(workspaceId, conversationId, text, {
      authorType: 'AI',
      authorId: null,
    });
  }

  /** Shared takeover-reply plumbing for `reply()`/`replyAsAi()`: pause the AI
   *  engine for this thread (a reply from outside it is always a takeover,
   *  human or MCP-agent) and send with the given author attribution. */
  private async sendTakeoverReply(
    workspaceId: string,
    conversationId: string,
    text: string,
    author: { authorType: 'AGENT' | 'AI'; authorId: string | null },
  ) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { aiPaused: true, unreadCount: 0 },
    });
    return this.sender.send({
      workspaceId,
      conversationId,
      text,
      authorType: author.authorType,
      authorId: author.authorId,
    });
  }

  async assign(workspaceId: string, conversationId: string, assignedToId: string | null) {
    const target = assignedToId && assignedToId.length > 0 ? assignedToId : null;
    if (target) await this.assertActiveMember(workspaceId, target);
    const updated = await this.scopedUpdate(workspaceId, conversationId, { assignedToId: target });
    // After the write: an assignment that threw must not have announced itself.
    // Unassigning (target null) notifies nobody — there is no new owner.
    if (target) await this.notifyAssignee(workspaceId, conversationId, target, updated.leadId);
    return this.touch(workspaceId, conversationId);
  }

  async setAiPaused(workspaceId: string, conversationId: string, paused: boolean) {
    await this.scopedUpdate(workspaceId, conversationId, { aiPaused: paused });
    return this.touch(workspaceId, conversationId);
  }

  async close(workspaceId: string, conversationId: string) {
    await this.scopedUpdate(workspaceId, conversationId, {
      status: 'CLOSED',
      closedAt: new Date(),
    });
    return this.touch(workspaceId, conversationId);
  }

  async reopen(workspaceId: string, conversationId: string) {
    await this.scopedUpdate(workspaceId, conversationId, { status: 'OPEN', closedAt: null });
    return this.touch(workspaceId, conversationId);
  }

  async markRead(workspaceId: string, conversationId: string) {
    await this.scopedUpdate(workspaceId, conversationId, { unreadCount: 0 });
    return { ok: true };
  }

  // ── Internal notes (team-only, never delivered to the contact) ──────────────

  async listNotes(workspaceId: string, conversationId: string) {
    await this.assertConvo(workspaceId, conversationId);
    return this.prisma.conversationNote.findMany({
      where: { workspaceId, conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Add an INTERNAL note. Written to conversation_notes (NOT messages), so it
   *  can never reach a channel adapter's send egress. Streamed for live inboxes. */
  async addNote(workspaceId: string, conversationId: string, authorId: string, body: string) {
    const convo = await this.assertConvo(workspaceId, conversationId);
    const note = await this.prisma.conversationNote.create({
      data: { workspaceId, conversationId, authorId, body },
    });
    // 'note' is hard-excluded from the public widget stream by the stream
    // service's contact-safe allowlist — it reaches the agent Inbox only, which
    // is also the only stream `leadId` is allowed on.
    this.stream.push(workspaceId, {
      kind: 'note',
      conversationId,
      leadId: convo.leadId,
      payload: note,
    });
    return note;
  }

  // ── Bulk actions over a set of conversations ────────────────────────────────

  /** Apply one action to many conversations at once (workspace-scoped). */
  async bulk(
    workspaceId: string,
    conversationIds: string[],
    action: 'close' | 'reopen' | 'assign' | 'markRead',
    payload: { assignedToId?: string | null } = {},
  ) {
    const ids = [...new Set(conversationIds)].filter((s) => typeof s === 'string' && s.length > 0);
    if (ids.length === 0) return { updated: 0 };

    let data: Record<string, unknown>;
    let assignTarget: string | null = null;
    switch (action) {
      case 'close':
        data = { status: 'CLOSED', closedAt: new Date() };
        break;
      case 'reopen':
        data = { status: 'OPEN', closedAt: null };
        break;
      case 'markRead':
        data = { unreadCount: 0 };
        break;
      case 'assign': {
        const target = payload.assignedToId && payload.assignedToId.length > 0 ? payload.assignedToId : null;
        if (target) await this.assertActiveMember(workspaceId, target);
        assignTarget = target;
        data = { assignedToId: target };
        break;
      }
    }
    // updateMany is scoped by (id IN ids, workspaceId): ids from another
    // workspace simply fall out of the match (count reflects only owned rows).
    const res = await this.prisma.conversation.updateMany({
      where: { id: { in: ids }, workspaceId },
      data,
    });
    // One notification per thread actually handed over. Ids belonging to
    // another workspace fell out of the updateMany above, so notify only for
    // rows this workspace really owns — otherwise a bulk call padded with
    // foreign ids would announce threads the assignee never received.
    if (assignTarget && res.count > 0) {
      const owned = await this.prisma.conversation.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, leadId: true },
      });
      for (const c of owned) await this.notifyAssignee(workspaceId, c.id, assignTarget, c.leadId);
    }
    return { updated: res.count };
  }

  /** The workspace-scoping check, and the two ids a caller needs afterwards.
   *  `leadId` rides along because every frame pushed from here has to say whose
   *  it is, and re-reading the same row to learn that would be a second query
   *  for a column the first one could have selected. */
  private async assertConvo(workspaceId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, leadId: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return convo;
  }

  private async scopedUpdate(workspaceId: string, conversationId: string, data: any) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      // leadId rides along for callers that announce the write (assign notifies
      // the new owner and needs somewhere for the click to land).
      select: { id: true, leadId: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    await this.prisma.conversation.update({ where: { id: convo.id }, data });
    return convo;
  }

  private async touch(workspaceId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
    if (convo) {
      this.stream.push(workspaceId, {
        kind: 'conversation',
        conversationId,
        leadId: convo.leadId,
        payload: convo,
      });
    }
    return convo;
  }

  /** Attach lead + channel summaries + a last-message snippet to a list of threads. */
  private async enrich(workspaceId: string, convos: any[]) {
    if (convos.length === 0) return [];
    const leadIds = [...new Set(convos.map((c) => c.leadId))];
    const channelIds = [...new Set(convos.map((c) => c.channelId))];
    const convoIds = convos.map((c) => c.id);

    const [leads, channels, lastMsgs] = await Promise.all([
      this.prisma.lead.findMany({
        where: { workspaceId, id: { in: leadIds } },
        select: { id: true, businessName: true, contactPerson: true },
      }),
      this.prisma.channel.findMany({
        where: { workspaceId, id: { in: channelIds } },
        select: { id: true, type: true, name: true },
      }),
      // One row per conversation, not every message of every conversation.
      //
      // This used to be a findMany over `conversationId IN (...)` with no
      // `take`, sorted desc, keeping the first per conversation in JS. The list
      // caps at 100 conversations and a thread is allowed to reach 500
      // messages, so producing 100 snippets could pull 50,000 rows across the
      // wire and discard 49,900 of them. It grows with conversation LENGTH,
      // which is exactly the thing that grows once the inbox is really used.
      //
      // Prisma has no per-group limit, so this is DISTINCT ON — the Postgres
      // feature for precisely this shape. workspaceId is in the predicate, so
      // the raw query is scoped like every other read here.
      this.prisma.$queryRaw<
        Array<{ conversationId: string; body: string; direction: string; createdAt: Date }>
      >`
        SELECT DISTINCT ON ("conversationId")
               "conversationId", "body", "direction", "createdAt"
        FROM "messages"
        WHERE "workspaceId" = ${workspaceId}
          AND "conversationId" IN (${Prisma.join(convoIds)})
        ORDER BY "conversationId", "createdAt" DESC
      `,
    ]);
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const lastByConvo = new Map<string, (typeof lastMsgs)[number]>();
    for (const m of lastMsgs) if (!lastByConvo.has(m.conversationId)) lastByConvo.set(m.conversationId, m);

    return convos.map((c) => ({
      ...c,
      lead: leadById.get(c.leadId) ?? null,
      channel: channelById.get(c.channelId) ?? null,
      lastMessage: lastByConvo.get(c.id) ?? null,
    }));
  }
}
