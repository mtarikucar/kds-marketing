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

const GRAPH = 'https://graph.facebook.com/v19.0';

/**
 * WhatsApp Cloud API adapter. Secrets: { accessToken, phoneNumberId }. The
 * `phoneNumberId` doubles as the channel's `externalId` so the Meta webhook can
 * resolve which channel an inbound message belongs to. Sends are plain text
 * (the 24h customer-service window is the caller's concern — `session-window`
 * capability advertises it). Never throws on a provider error — returns FAILED.
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

  async send({ config, to, text }: OutboundSend): Promise<SendResult> {
    const token = config.secrets.accessToken;
    const phoneNumberId = config.secrets.phoneNumberId || config.externalId;
    if (!token || !phoneNumberId) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: 'WhatsApp channel not configured (accessToken/phoneNumberId)',
      };
    }
    try {
      const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        }),
        // undici fetch has no default total timeout — bound it so a black-holed
        // Graph endpoint can't hang the sequential job batch / pin a quota slot.
        signal: AbortSignal.timeout(10_000),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          externalMessageId: null,
          status: 'FAILED',
          error: `WA ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`,
        };
      }
      return { externalMessageId: data?.messages?.[0]?.id ?? null, status: 'SENT' };
    } catch (e: any) {
      return { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
    }
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
          out.push({
            externalUserId: String(m.from),
            kind: 'WA',
            externalMessageId: m?.id ?? null,
            text: String(text),
            displayName: nameByWaId.get(m.from) || null,
            raw: m,
          });
        }
      }
    }
    return out;
  }

  async healthCheck(
    config: ResolvedChannelConfig,
  ): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    const hasToken = !!config.secrets.accessToken;
    const hasPhone = !!(config.secrets.phoneNumberId || config.externalId);
    return { ok: hasToken && hasPhone, details: { hasToken, hasPhoneNumberId: hasPhone } };
  }
}
