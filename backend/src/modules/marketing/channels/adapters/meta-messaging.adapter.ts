import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  ContactKind,
  InboundMessage,
  OutboundMedia,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
  StatusUpdate,
} from '../channel-adapter.interface';
import { metaGraphFetch } from '../../../../common/util/meta-graph.util';
import { parseMessengerStatuses } from '../meta-status.util';

const CAPS: readonly ChannelCapability[] = ['send', 'receive', 'delivery-receipts'];

/**
 * Facebook Messenger + Instagram DM share the Meta Graph "Send API" and webhook
 * shape (entry[].messaging[]), differing only in the page-scoped user-id kind
 * (PSID for Messenger, IGSID for Instagram). One helper, two thin adapters.
 * Secrets: { pageAccessToken }. The channel's `externalId` is the page id the
 * webhook resolves by. Supports text + by-URL media (image/file). Templates are
 * WhatsApp-only and ignored here. Never throws on a provider error — FAILED.
 */
async function metaSend(
  token: string | undefined,
  recipientId: string,
  opts: { text: string; media?: OutboundMedia },
): Promise<SendResult> {
  if (!token) {
    return { externalMessageId: null, status: 'FAILED', error: 'page access token missing' };
  }
  const message = opts.media
    ? {
        attachment: {
          type: opts.media.kind === 'document' ? 'file' : 'image',
          payload: { url: opts.media.url, is_reusable: false },
        },
      }
    : { text: opts.text };
  const r = await metaGraphFetch('/me/messages', {
    accessToken: token,
    method: 'POST',
    body: { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message },
    timeoutMs: 10_000,
  });
  if (!r.ok) {
    return {
      externalMessageId: null,
      status: 'FAILED',
      error: `Meta ${r.status}: ${String(r.error?.message ?? '').slice(0, 300)}`,
    };
  }
  return { externalMessageId: r.data?.message_id ?? null, status: 'SENT' };
}

/**
 * Is our app actually subscribed to this Page's `messages` webhook?
 *
 * A live token and a delivering webhook are INDEPENDENT. Embedded Signup
 * subscribes the app as a separate call, and that call is best-effort — a
 * failure there is logged and the channel is still created. Nothing afterwards
 * ever looked again.
 *
 * So a channel can hold a perfectly valid token, pass verify, sit there ACTIVE,
 * and never receive one inbound message for as long as it exists. That is the
 * business's front door, and it fails without a single error anywhere.
 *
 * Three-valued on purpose. `false` means Meta told us plainly that nothing is
 * subscribed; `null` means the probe itself did not answer (a permission the
 * token lacks, a transport failure), and an unanswered probe must never be
 * allowed to condemn a channel that is actually working.
 */
async function webhookSubscription(
  token: string,
  nodeId: string,
): Promise<{ subscribed: boolean | null; fields: string[]; error?: string }> {
  const r = await metaGraphFetch(`/${nodeId}/subscribed_apps`, {
    accessToken: token,
    method: 'GET',
    timeoutMs: 10_000,
  });
  if (!r.ok) {
    return {
      subscribed: null,
      fields: [],
      error: String(r.error?.message ?? `HTTP ${r.status}`).slice(0, 300),
    };
  }

  const apps: Array<{ id?: unknown; subscribed_fields?: unknown }> = Array.isArray(r.data?.data)
    ? r.data.data
    : [];
  // Nothing at all is listening. Unambiguous, whether or not we know our app id.
  if (!apps.length) return { subscribed: false, fields: [] };

  const appId = process.env.META_APP_ID;
  const fieldsOf = (a: { subscribed_fields?: unknown }) =>
    Array.isArray(a.subscribed_fields) ? a.subscribed_fields.map(String) : [];

  if (appId) {
    const mine = apps.find((a) => String(a.id) === appId);
    if (!mine) return { subscribed: false, fields: [] };
    const fields = fieldsOf(mine);
    return { subscribed: fields.includes('messages'), fields };
  }

  // Without META_APP_ID we cannot tell OUR app from someone else's, so the most
  // we can honestly say is whether anything is subscribed to `messages`.
  const any = apps.find((a) => fieldsOf(a).includes('messages'));
  return { subscribed: !!any, fields: any ? fieldsOf(any) : [] };
}

async function metaHealthCheck(
  token: string | undefined,
  externalId: string | null,
): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
  if (!token || !externalId) {
    return { ok: false, details: { hasToken: !!token, hasPageId: !!externalId } };
  }
  const r = await metaGraphFetch('/me', {
    accessToken: token,
    method: 'GET',
    query: { fields: 'id,name' },
    timeoutMs: 10_000,
  });
  if (!r.ok) {
    return { ok: false, details: { error: String(r.error?.message ?? `HTTP ${r.status}`).slice(0, 300) } };
  }

  const base = { id: r.data?.id ?? null, name: r.data?.name ?? null };
  const sub = await webhookSubscription(token, externalId);

  if (sub.subscribed === false) {
    // The token works; the channel still cannot hear anyone. Saying "ok" here
    // is what let this state persist unnoticed.
    return {
      ok: false,
      details: {
        ...base,
        webhookSubscribed: false,
        error:
          "Token is valid but this Page is not subscribed to the app's `messages` webhook — inbound messages are never delivered. Reconnect the channel to re-subscribe.",
      },
    };
  }

  return {
    ok: true,
    details: {
      ...base,
      // null = the probe could not answer; surfaced rather than hidden so an
      // unanswerable probe is visible as unknown instead of passing as healthy.
      webhookSubscribed: sub.subscribed,
      subscribedFields: sub.fields,
      ...(sub.error ? { webhookProbeError: sub.error } : {}),
    },
  };
}

function parseMetaMessaging(body: unknown, kind: ContactKind): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of (body as any)?.entry ?? []) {
    for (const ev of entry?.messaging ?? []) {
      const senderId = ev?.sender?.id;
      const text = ev?.message?.text;
      // Skip echoes (our own sends) and non-text events (delivery/read receipts
      // are handled by parseStatusUpdates, not here).
      if (!senderId || ev?.message?.is_echo || typeof text !== 'string') continue;
      // Click-to-Messenger/Instagram ad referral (D10b): an ads-sourced thread
      // carries `referral` (ad_id + referer_uri + source). Only surface it when
      // it actually identifies a source.
      const ref = ev?.referral ?? ev?.postback?.referral;
      const referral =
        ref && (ref.ad_id || ref.source_id)
          ? {
              sourceId: ref.ad_id != null ? String(ref.ad_id) : ref.source_id != null ? String(ref.source_id) : null,
              ctwaClid: ref.ctwa_clid != null ? String(ref.ctwa_clid) : null,
              sourceUrl: ref.referer_uri != null ? String(ref.referer_uri) : ref.source_url != null ? String(ref.source_url) : null,
              sourceType: ref.source != null ? String(ref.source) : ref.type != null ? String(ref.type) : null,
            }
          : undefined;
      out.push({
        externalUserId: String(senderId),
        kind,
        externalMessageId: ev?.message?.mid ?? null,
        text,
        ...(referral ? { referral } : {}),
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

  send({ config, to, text, media }: OutboundSend): Promise<SendResult> {
    return metaSend(config.secrets.pageAccessToken, to, { text, media });
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    return parseMetaMessaging(body, 'PSID');
  }

  parseStatusUpdates(_config: ResolvedChannelConfig, body: unknown): StatusUpdate[] {
    return parseMessengerStatuses(body);
  }

  healthCheck(config: ResolvedChannelConfig) {
    return metaHealthCheck(config.secrets.pageAccessToken, config.externalId);
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

  send({ config, to, text, media }: OutboundSend): Promise<SendResult> {
    return metaSend(config.secrets.pageAccessToken, to, { text, media });
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    return parseMetaMessaging(body, 'IGSID');
  }

  parseStatusUpdates(_config: ResolvedChannelConfig, body: unknown): StatusUpdate[] {
    return parseMessengerStatuses(body);
  }

  healthCheck(config: ResolvedChannelConfig) {
    return metaHealthCheck(config.secrets.pageAccessToken, config.externalId);
  }
}
