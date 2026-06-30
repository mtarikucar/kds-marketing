import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Sse,
  Header,
  NotFoundException,
  BadRequestException,
  MessageEvent,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { Observable, from, interval, merge } from 'rxjs';
import { switchMap, map } from 'rxjs/operators';
import { PrismaService } from '../../../prisma/prisma.service';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ConversationIngressService } from '../channels/conversation-ingress.service';
import { ConversationStreamService } from '../channels/conversation-stream.service';
import { BrandingService } from '../branding/branding.service';
import { WebchatMessageDto, WebchatSessionDto } from '../dto/conversation.dto';

/**
 * Public web-chat widget API (no marketing auth — gated by the unguessable
 * widgetKey + visitorId; ThrottlerGuard rate-limits abuse). The widget mints a
 * visitorId on session start, posts messages (which flow through the same
 * ConversationIngress as every other channel), and streams the thread over SSE.
 * Reads are bound to (channel, conversation, visitorId) so a leaked
 * conversationId alone can't surface another visitor's thread.
 */
@Controller('public/webchat')
export class WebchatPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PublicChannelResolverService,
    private readonly ingress: ConversationIngressService,
    private readonly stream: ConversationStreamService,
    private readonly branding: BrandingService,
  ) {}

  @Post(':widgetKey/session')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  async session(@Param('widgetKey') widgetKey: string, @Body() dto: WebchatSessionDto) {
    const channel = await this.activeWebchat(widgetKey);
    const pub = (channel.configPublic ?? {}) as Record<string, unknown>;
    const branding = await this.branding.get(channel.workspaceId);
    return {
      visitorId: dto.visitorId || randomUUID(),
      channel: { name: branding.brandName || channel.name, greeting: pub.greeting ?? null },
      branding,
    };
  }

  @Post(':widgetKey/messages')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  async postMessage(@Param('widgetKey') widgetKey: string, @Body() dto: WebchatMessageDto) {
    const channel = await this.activeWebchat(widgetKey);
    const res = await this.ingress.ingest(
      { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
      {
        externalUserId: dto.visitorId,
        kind: 'WEBCHAT',
        externalMessageId: null,
        text: dto.text.trim(),
      },
    );
    if (!res) throw new BadRequestException('Could not accept message');
    return { conversationId: res.conversationId };
  }

  @Get(':widgetKey/history')
  async history(
    @Param('widgetKey') widgetKey: string,
    @Query('conversationId') conversationId: string,
    @Query('visitorId') visitorId: string,
  ) {
    const ctx = await this.resolveThread(widgetKey, conversationId, visitorId);
    const messages = await this.prisma.message.findMany({
      where: { workspaceId: ctx.workspaceId, conversationId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, direction: true, authorType: true, body: true, createdAt: true },
    });
    return { messages };
  }

  @Sse(':widgetKey/stream')
  @Header('X-Accel-Buffering', 'no')
  streamThread(
    @Param('widgetKey') widgetKey: string,
    @Query('conversationId') conversationId: string,
    @Query('visitorId') visitorId: string,
  ): Observable<MessageEvent> {
    return from(this.resolveThread(widgetKey, conversationId, visitorId)).pipe(
      switchMap((ctx) =>
        merge(
          this.stream
            .forConversation(ctx.workspaceId, conversationId)
            .pipe(map((e) => ({ data: e }) as MessageEvent)),
          interval(25_000).pipe(map(() => ({ data: { kind: 'heartbeat' } }) as MessageEvent)),
        ),
      ),
    );
  }

  // ---- helpers ----

  private async activeWebchat(widgetKey: string) {
    const channel = await this.resolver.byWidgetKey(widgetKey);
    if (!channel || channel.type !== 'WEBCHAT' || channel.status !== 'ACTIVE') {
      throw new NotFoundException('Web-chat channel not found');
    }
    return channel;
  }

  /** Resolve + authorize a (channel, conversation, visitor) triple for reads. */
  private async resolveThread(widgetKey: string, conversationId: string, visitorId: string) {
    if (!conversationId || !visitorId) throw new BadRequestException('Missing conversation/visitor');
    const channel = await this.activeWebchat(widgetKey);
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: channel.workspaceId, channelId: channel.id },
      select: { id: true, contactIdentityId: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    // Bind the thread to the visitor: the conversation's identity must match.
    // FAIL CLOSED — a conversation with no identity has no owning visitor, so it
    // must NOT be readable by an arbitrary visitorId (otherwise a leaked
    // conversationId alone would surface the thread, breaking the guarantee in
    // the class doc). Every webchat conversation is born with an identity via
    // ingress, so this only rejects a malformed/identity-less row.
    if (!convo.contactIdentityId) {
      throw new NotFoundException('Conversation not found');
    }
    const identity = await this.prisma.contactIdentity.findFirst({
      where: { id: convo.contactIdentityId, workspaceId: channel.workspaceId },
      select: { value: true },
    });
    if (!identity || identity.value !== visitorId) {
      throw new NotFoundException('Conversation not found');
    }
    return { workspaceId: channel.workspaceId };
  }
}
