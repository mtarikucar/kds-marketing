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
      this.prisma.message.findMany({
        where: { workspaceId, conversationId },
        orderBy: { createdAt: 'asc' },
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
    return { conversation: convo, messages, lead, channel };
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
    await this.scopedUpdate(workspaceId, conversationId, { assignedToId });
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
