import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
} from '../channel-adapter.interface';

/**
 * Voice is a config-only channel: the row holds the Twilio creds
 * (accountSid/authToken) + the inbound number (externalId) + the agent that
 * answers. There is no text "send" (calls are answered live by VoiceAiService
 * via TwiML), so `send` always FAILS; only config storage + healthCheck apply.
 */
@Injectable()
export class VoiceAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'VOICE' as const;
  readonly capabilities: readonly ChannelCapability[] = ['receive'];

  constructor(private readonly registry: ChannelAdapterRegistry) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  async send(_send: OutboundSend): Promise<SendResult> {
    return { externalMessageId: null, status: 'FAILED', error: 'voice is inbound-only' };
  }

  async healthCheck(config: ResolvedChannelConfig): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    const ok = !!config.secrets.accountSid && !!config.secrets.authToken && !!config.externalId;
    return { ok, details: { hasCreds: ok, number: config.externalId } };
  }
}
