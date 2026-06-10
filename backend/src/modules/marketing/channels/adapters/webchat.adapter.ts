import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  OutboundSend,
  SendResult,
} from '../channel-adapter.interface';

/**
 * Web-chat — the internal channel. There is no external transport: an outbound
 * message is delivered by persisting the Message and pushing it over SSE to the
 * widget (MessageSenderService + ConversationStreamService do that). So `send`
 * is an immediate success, and inbound arrives via the public web-chat
 * controller (which builds the InboundMessage directly), not a webhook parse.
 */
@Injectable()
export class WebchatAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'WEBCHAT' as const;
  readonly capabilities: readonly ChannelCapability[] = ['send', 'receive'];

  constructor(private readonly registry: ChannelAdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async send(_send: OutboundSend): Promise<SendResult> {
    return { externalMessageId: null, status: 'SENT' };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    return { ok: true, details: { transport: 'internal (SSE)' } };
  }
}
