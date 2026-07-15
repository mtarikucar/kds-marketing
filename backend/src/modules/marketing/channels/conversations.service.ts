import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MessageSenderService } from './message-sender.service';
import { ConversationStreamService } from './conversation-stream.service';

export interface ConversationListFilters {
  status?: string;
  channelId?: string;
  assignedToId?: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: MessageSenderService,
    private readonly stream: ConversationStreamService,
  ) {}

  async list(workspaceId: string, filters: ConversationListFilters = {}) {
    const convos = await this.prisma.conversation.findMany({
      where: {
        workspaceId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.channelId ? { channelId: filters.channelId } : {}),
        ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
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
      authorType: 'AGENT',
      authorId: agentUserId,
    });
  }

  async assign(workspaceId: string, conversationId: string, assignedToId: string | null) {
    const target = assignedToId && assignedToId.length > 0 ? assignedToId : null;
    if (target) {
      // The assignee must belong to this workspace (no cross-tenant assign) —
      // the same guard the bulk() path enforces; the single path was missing it,
      // letting a foreign/unknown id be written as the conversation's owner.
      const user = await this.prisma.marketingUser.findFirst({
        where: { id: target, workspaceId },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('Assignee not found');
    }
    await this.scopedUpdate(workspaceId, conversationId, { assignedToId: target });
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
    await this.assertConvo(workspaceId, conversationId);
    const note = await this.prisma.conversationNote.create({
      data: { workspaceId, conversationId, authorId, body },
    });
    // 'note' is hard-excluded from the public widget stream by the stream
    // service's contact-safe allowlist — it reaches the agent Inbox only.
    this.stream.push(workspaceId, { kind: 'note', conversationId, payload: note });
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
        if (target) {
          // The assignee must belong to this workspace (no cross-tenant assign).
          const user = await this.prisma.marketingUser.findFirst({
            where: { id: target, workspaceId },
            select: { id: true },
          });
          if (!user) throw new NotFoundException('Assignee not found');
        }
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
    return { updated: res.count };
  }

  private async assertConvo(workspaceId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
  }

  private async scopedUpdate(workspaceId: string, conversationId: string, data: any) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    await this.prisma.conversation.update({ where: { id: convo.id }, data });
  }

  private async touch(workspaceId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
    if (convo) {
      this.stream.push(workspaceId, { kind: 'conversation', conversationId, payload: convo });
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
      this.prisma.message.findMany({
        where: { workspaceId, conversationId: { in: convoIds } },
        orderBy: { createdAt: 'desc' },
        select: { conversationId: true, body: true, direction: true, createdAt: true },
      }),
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
