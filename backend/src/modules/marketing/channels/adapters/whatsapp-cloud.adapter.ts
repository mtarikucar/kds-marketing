import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  InboundMessage,
  OutboundMedia,
  OutboundSend,
  OutboundTemplate,
  ResolvedChannelConfig,
  SendResult,
  StatusUpdate,
} from '../channel-adapter.interface';
import { metaGraphFetch, metaWebhookSubscription } from '../../../../common/util/meta-graph.util';
import { parseWaStatuses } from '../meta-status.util';

/**
 * WhatsApp Cloud API adapter. Secrets: { accessToken, phoneNumberId }. The
 * `phoneNumberId` doubles as the channel's `externalId` so the Meta webhook can
 * resolve which channel an inbound message belongs to. Supports text, an
 * already-approved template (reopens the 24h window), and by-URL media. Inbound
 * messages + delivery/read receipts both arrive on the shared Meta webhook.
 * Never throws on a provider error — returns FAILED.
 */
/**
 * Which WABA does this token speak for?
 *
 * The subscription that decides whether inbound messages are delivered lives on
 * the WABA, and a WHATSAPP channel stores only `phoneNumberId` — the WABA id is
 * nowhere in our data. The phone-number node does not carry it either: asking
 * `GET /{phone-number-id}?fields=whatsapp_business_account` returns
 * "(#100) Tried accessing nonexisting field", which is how the first attempt at
 * this failed against the live channel.
 *
 * The documented route is the token itself. An Embedded Signup token is scoped
 * to the WABAs it was granted, and `/debug_token` reports that as
 * `granular_scopes[].target_ids`.
 *
 * Returns exactly one id or nothing. If the token covers SEVERAL WABAs there is
 * no way from here to say which one this number belongs to, and guessing would
 * put a confident wrong answer where an honest "unknown" belongs — the same
 * mistake the three-valued probe exists to avoid.
 */
async function resolveWabaId(token: string): Promise<{ id?: string; error?: string }> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return { error: 'META_APP_ID / META_APP_SECRET are not configured on this platform' };
  }
  try {
    const r = await metaGraphFetch('/debug_token', {
      // BOTH tokens go in the query on purpose. Passing the app token as
      // `accessToken` would make the client attach an appsecret_proof computed
      // from the app token, which is not what this endpoint expects.
      query: { input_token: token, access_token: `${appId}|${appSecret}` },
      timeoutMs: 10_000,
    });
    if (!r.ok) {
      return { error: String(r.error?.message ?? `HTTP ${r.status}`).slice(0, 300) };
    }
    const scopes: Array<{ scope?: unknown; target_ids?: unknown }> = Array.isArray(
      r.data?.data?.granular_scopes,
    )
      ? r.data.data.granular_scopes
      : [];
    const targets = new Set<string>();
    for (const sc of scopes) {
      if (typeof sc?.scope !== 'string' || !sc.scope.startsWith('whatsapp_business')) continue;
      for (const t of Array.isArray(sc.target_ids) ? sc.target_ids : []) targets.add(String(t));
    }
    if (targets.size === 1) return { id: [...targets][0] };
    if (targets.size === 0) {
      return { error: 'this token grants no whatsapp_business scope with a target account' };
    }
    return {
      error: `this token covers ${targets.size} WhatsApp accounts; cannot tell which one this number belongs to`,
    };
  } catch {
    // The ONE call in this file whose URL carries the app secret. A transport
    // error can quote the URL it failed on, and these details are surfaced to
    // callers and written to logs — so it never leaves here verbatim.
    return { error: 'WABA lookup failed (transport error)' };
  }
}

@Injectable()
export class WhatsappCloudAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'WHATSAPP' as const;
  readonly capabilities: readonly ChannelCapability[] = [
    'send',
    'receive',
    'delivery-receipts',
    'session-window',
  ];
  private readonly logger = new Logger(WhatsappCloudAdapter.name);

  constructor(private readonly registry: ChannelAdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async send({ config, to, text, template, media }: OutboundSend): Promise<SendResult> {
    const token = config.secrets.accessToken;
    const phoneNumberId = config.secrets.phoneNumberId || config.externalId;
    if (!token || !phoneNumberId) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: 'WhatsApp channel not configured (accessToken/phoneNumberId)',
      };
    }
    const body = this.buildBody(to, text, template, media);
    // Cloud API uses a Bearer token; appsecret_proof rides the query (harmless).
    const r = await metaGraphFetch(`/${phoneNumberId}/messages`, {
      accessToken: token,
      bearer: true,
      method: 'POST',
      body,
      timeoutMs: 10_000,
    });
    if (!r.ok) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: `WA ${r.status}: ${String(r.error?.message ?? '').slice(0, 300)}`,
      };
    }
    return { externalMessageId: r.data?.messages?.[0]?.id ?? null, status: 'SENT' };
  }

  /** Build the Graph message body; precedence template > media > text. */
  private buildBody(
    to: string,
    text: string,
    template?: OutboundTemplate,
    media?: OutboundMedia,
  ): Record<string, unknown> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    if (template) {
      return {
        ...base,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.languageCode },
          ...(template.components ? { components: template.components } : {}),
        },
      };
    }
    if (media) {
      if (media.kind === 'document') {
        return {
          ...base,
          type: 'document',
          document: {
            link: media.url,
            ...(media.filename ? { filename: media.filename } : {}),
            ...(media.caption ? { caption: media.caption } : {}),
          },
        };
      }
      return {
        ...base,
        type: 'image',
        image: { link: media.url, ...(media.caption ? { caption: media.caption } : {}) },
      };
    }
    return { ...base, type: 'text', text: { body: text } };
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const entries = (body as any)?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        const nameByWaId = new Map<string, string>();
        for (const c of value?.contacts ?? []) {
          if (c?.wa_id) nameByWaId.set(c.wa_id, c?.profile?.name ?? '');
        }
        for (const m of value?.messages ?? []) {
          if (!m?.from) continue;
          const text =
            m?.text?.body ??
            m?.button?.text ??
            m?.interactive?.list_reply?.title ??
            m?.interactive?.button_reply?.title ??
            '';
          // Click-to-WhatsApp ad referral (D10b): the FIRST message from a CTWA
          // click carries `referral` (source_id = ad id, ctwa_clid, source_url).
          // Only surface it when it actually identifies a source.
          const ref = m?.referral;
          const referral =
            ref && (ref.source_id || ref.ctwa_clid)
              ? {
                  sourceId: ref.source_id != null ? String(ref.source_id) : null,
                  ctwaClid: ref.ctwa_clid != null ? String(ref.ctwa_clid) : null,
                  sourceUrl: ref.source_url != null ? String(ref.source_url) : null,
                  sourceType: ref.source_type != null ? String(ref.source_type) : null,
                }
              : undefined;
          out.push({
            externalUserId: String(m.from),
            kind: 'WA',
            externalMessageId: m?.id ?? null,
            text: String(text),
            displayName: nameByWaId.get(m.from) || null,
            ...(referral ? { referral } : {}),
            raw: m,
          });
        }
      }
    }
    return out;
  }

  parseStatusUpdates(_config: ResolvedChannelConfig, body: unknown): StatusUpdate[] {
    return parseWaStatuses(body);
  }

  async healthCheck(
    config: ResolvedChannelConfig,
  ): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    const token = config.secrets.accessToken;
    const phoneNumberId = config.secrets.phoneNumberId || config.externalId;
    if (!token || !phoneNumberId) {
      return { ok: false, details: { hasToken: !!token, hasPhoneNumberId: !!phoneNumberId } };
    }
    // Live probe: a 200 proves the token can read the phone number; 401/190 ⇒ bad token.
    const r = await metaGraphFetch(`/${phoneNumberId}`, {
      accessToken: token,
      bearer: true,
      method: 'GET',
      query: { fields: 'verified_name,quality_rating' },
      timeoutMs: 10_000,
    });
    if (!r.ok) {
      return { ok: false, details: { error: String(r.error?.message ?? `HTTP ${r.status}`).slice(0, 300) } };
    }
    const base = {
      verifiedName: r.data?.verified_name ?? null,
      qualityRating: r.data?.quality_rating ?? null,
    };

    // Can this number actually RECEIVE?
    //
    // A working token and a delivering webhook are independent, and on WhatsApp
    // the gap is wider than elsewhere: Embedded Signup subscribes the app to the
    // WABA in a separate best-effort call (channels.service.ts), so a failure
    // there is logged and the channel is created anyway. Nothing looked again.
    //
    // The subscription lives on the WABA, and this channel stores only
    // phoneNumberId — the WABA id is nowhere in our data, so it has to be
    // resolved from the number first. That resolution may simply not be
    // available to this token, which is exactly why the probe is three-valued:
    // `null` means "could not find out", and an unanswered probe must never be
    // allowed to condemn a number that is working. Only a clear "not
    // subscribed" from Meta fails the channel.
    const waba = await resolveWabaId(token);
    if (!waba.id) {
      return {
        ok: true,
        details: { ...base, webhookSubscribed: null, webhookProbeError: waba.error },
      };
    }
    const wabaId = waba.id;

    const sub = await metaWebhookSubscription(token, wabaId, { bearer: true });
    if (sub.subscribed === false) {
      return {
        ok: false,
        details: {
          ...base,
          wabaId,
          webhookSubscribed: false,
          error:
            "Token is valid but this WhatsApp Business Account is not subscribed to the app's `messages` webhook — inbound messages are never delivered. Reconnect the channel to re-subscribe.",
        },
      };
    }

    return {
      ok: true,
      details: {
        ...base,
        wabaId,
        webhookSubscribed: sub.subscribed,
        subscribedFields: sub.fields,
        ...(sub.error ? { webhookProbeError: sub.error } : {}),
      },
    };
  }
}
