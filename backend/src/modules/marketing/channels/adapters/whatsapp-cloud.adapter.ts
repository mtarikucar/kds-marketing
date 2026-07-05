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
import { metaGraphFetch } from '../../../../common/util/meta-graph.util';
import { parseWaStatuses } from '../meta-status.util';

/**
 * WhatsApp Cloud API adapter. Secrets: { accessToken, phoneNumberId }. The
 * `phoneNumberId` doubles as the channel's `externalId` so the Meta webhook can
 * resolve which channel an inbound message belongs to. Supports text, an
 * already-approved template (reopens the 24h window), and by-URL media. Inbound
 * messages + delivery/read receipts both arrive on the shared Meta webhook.
 * Never throws on a provider error — returns FAILED.
 */
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
    return {
      ok: true,
      details: { verifiedName: r.data?.verified_name ?? null, qualityRating: r.data?.quality_rating ?? null },
    };
  }
}
