import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  InboundMessage,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
} from '../channel-adapter.interface';

const CAPS: readonly ChannelCapability[] = ['send', 'receive'];

/**
 * TikTok Direct Messages (Business Messaging) inbox adapter — mirrors the Meta
 * Messenger adapter so it slots into the same registry → ingress → AI pipeline
 * unchanged. Secrets: { accessToken }. The channel's `externalId` is the TikTok
 * business/creator id the webhook resolves by.
 *
 * NOTE: TikTok's Business Messaging API is access-gated and less standardized
 * than Meta's. The send endpoint + inbound event shape below follow TikTok's
 * documented Business Messaging format; an operator with messaging access may
 * need to adjust the exact path/fields per their app's granted scopes. Fully
 * INERT without an access token (send → FAILED) — nothing runs until a workspace
 * connects a TikTok messaging account.
 */
@Injectable()
export class TiktokDmAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'TIKTOK' as const;
  readonly capabilities = CAPS;
  private readonly logger = new Logger(TiktokDmAdapter.name);

  constructor(private readonly registry: ChannelAdapterRegistry) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  async send({ config, to, text }: OutboundSend): Promise<SendResult> {
    const token = config.secrets.accessToken;
    if (!token) {
      return { externalMessageId: null, status: 'FAILED', error: 'TikTok access token missing' };
    }
    try {
      // TikTok Business Messaging send. Bounded like metaSend so a black-holed
      // endpoint can't wedge the sequential auto-reply batch.
      const res = await fetch('https://business-api.tiktok.com/open_api/v1.3/business/message/send/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Access-Token': token },
        body: JSON.stringify({
          business_id: config.externalId,
          to_user_id: to,
          message: { type: 'text', text },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data: any = await res.json().catch(() => ({}));
      // TikTok wraps results as { code, message, data }; code 0 = ok.
      if (!res.ok || (data?.code !== undefined && data.code !== 0)) {
        return {
          externalMessageId: null,
          status: 'FAILED',
          error: `TikTok ${res.status}: ${String(data?.message ?? JSON.stringify(data)).slice(0, 300)}`,
        };
      }
      return { externalMessageId: data?.data?.message_id ?? null, status: 'SENT' };
    } catch (e: any) {
      return { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
    }
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    // TikTok webhook: { event, data: { messages: [{ from_user_id, message_id,
    // content/text, ... }] } } (shape per Business Messaging webhooks).
    const events = (body as any)?.data?.messages ?? (body as any)?.messages ?? [];
    const businessId = _config.externalId != null ? String(_config.externalId) : null;
    for (const ev of events) {
      const rawSender = ev?.from_user_id ?? ev?.sender_id;
      // Coerce to string before the echo comparison — TikTok may send numeric
      // ids, and `123 === '123'` is false, which would let our own echo slip
      // past the filter and re-enter the AI pipeline (a reply loop).
      const senderId = rawSender != null ? String(rawSender) : '';
      const text = ev?.text ?? ev?.content?.text ?? ev?.content;
      // Skip our own echoes (sender == the connected business id) and non-text.
      if (!senderId || senderId === businessId || typeof text !== 'string') continue;
      out.push({
        externalUserId: senderId,
        kind: 'TIKTOKID',
        externalMessageId: ev?.message_id ?? null,
        text,
        displayName: ev?.from_user_name ?? null,
        raw: ev,
      });
    }
    return out;
  }

  async healthCheck(config: ResolvedChannelConfig) {
    const ok = !!config.secrets.accessToken && !!config.externalId;
    return { ok, details: { hasToken: !!config.secrets.accessToken, hasBusinessId: !!config.externalId } };
  }
}
