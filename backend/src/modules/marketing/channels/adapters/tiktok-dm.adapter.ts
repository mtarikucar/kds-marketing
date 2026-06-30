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
import { tiktokBusinessFetch } from '../tiktok-business.util';

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
 *
 * Capability gate: `config.public.messaging` must equal 'granted' (set by the
 * TikTok OAuth flow once the app has been approved for messaging scope). Without
 * this flag the send path short-circuits with FAILED and never contacts the API.
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
    // Capability gate: TikTok messaging is access-gated; the OAuth flow sets this
    // flag only after the app has been approved for the messaging scope.
    if (config.public?.messaging !== 'granted') {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: 'TikTok messaging access not granted for this channel',
      };
    }

    const token = config.secrets.accessToken;
    if (!token) {
      return { externalMessageId: null, status: 'FAILED', error: 'TikTok access token missing' };
    }

    try {
      const result = await tiktokBusinessFetch('/business/message/send/', {
        accessToken: token,
        method: 'POST',
        body: {
          business_id: config.externalId,
          to_user_id: to,
          message: { type: 'text', text },
        },
      });

      if (!result.ok) {
        const errResult = result as { ok: false; error: { message: string } };
        return {
          externalMessageId: null,
          status: 'FAILED',
          error: errResult.error.message.slice(0, 300),
        };
      }

      const okResult = result as { ok: true; data: any };
      return { externalMessageId: okResult.data?.message_id ?? null, status: 'SENT' };
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
