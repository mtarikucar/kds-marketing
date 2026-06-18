import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  ContactKind,
  InboundMessage,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
} from '../channel-adapter.interface';

const GRAPH = 'https://graph.facebook.com/v19.0';
const CAPS: readonly ChannelCapability[] = ['send', 'receive', 'delivery-receipts'];

/**
 * Facebook Messenger + Instagram DM share the Meta Graph "Send API" and webhook
 * shape (entry[].messaging[]), differing only in the page-scoped user-id kind
 * (PSID for Messenger, IGSID for Instagram). One helper, two thin adapters.
 * Secrets: { pageAccessToken }. The channel's `externalId` is the page id the
 * webhook resolves by.
 */
async function metaSend(
  logger: Logger,
  token: string | undefined,
  recipientId: string,
  text: string,
): Promise<SendResult> {
  if (!token) {
    return { externalMessageId: null, status: 'FAILED', error: 'page access token missing' };
  }
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { text },
      }),
      // Bound the call: undici's fetch has no default total timeout, so a
      // black-holed Graph endpoint would hang forever, wedging the sequential
      // scheduled-job batch (AI auto-replies run inside it) and holding a
      // reserved quota slot until the process is killed.
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: `Meta ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`,
      };
    }
    return { externalMessageId: data?.message_id ?? null, status: 'SENT' };
  } catch (e: any) {
    return { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
  }
}

function parseMetaMessaging(body: unknown, kind: ContactKind): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of (body as any)?.entry ?? []) {
    for (const ev of entry?.messaging ?? []) {
      const senderId = ev?.sender?.id;
      const text = ev?.message?.text;
      // Skip echoes (our own sends) and non-text events (delivery/read receipts).
      if (!senderId || ev?.message?.is_echo || typeof text !== 'string') continue;
      out.push({
        externalUserId: String(senderId),
        kind,
        externalMessageId: ev?.message?.mid ?? null,
        text,
        raw: ev,
      });
    }
  }
  return out;
}

@Injectable()
export class MessengerAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'MESSENGER' as const;
  readonly capabilities = CAPS;
  private readonly logger = new Logger(MessengerAdapter.name);

  constructor(private readonly registry: ChannelAdapterRegistry) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  send({ config, to, text }: OutboundSend): Promise<SendResult> {
    return metaSend(this.logger, config.secrets.pageAccessToken, to, text);
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    return parseMetaMessaging(body, 'PSID');
  }

  async healthCheck(config: ResolvedChannelConfig) {
    const ok = !!config.secrets.pageAccessToken && !!config.externalId;
    return { ok, details: { hasToken: !!config.secrets.pageAccessToken, hasPageId: !!config.externalId } };
  }
}

@Injectable()
export class InstagramAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'INSTAGRAM' as const;
  readonly capabilities = CAPS;
  private readonly logger = new Logger(InstagramAdapter.name);

  constructor(private readonly registry: ChannelAdapterRegistry) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  send({ config, to, text }: OutboundSend): Promise<SendResult> {
    return metaSend(this.logger, config.secrets.pageAccessToken, to, text);
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    return parseMetaMessaging(body, 'IGSID');
  }

  async healthCheck(config: ResolvedChannelConfig) {
    const ok = !!config.secrets.pageAccessToken && !!config.externalId;
    return { ok, details: { hasToken: !!config.secrets.pageAccessToken, hasPageId: !!config.externalId } };
  }
}
