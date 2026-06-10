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

/**
 * NetGSM SMS adapter. Secrets: { usercode, password, msgheader } (msgheader is
 * the İYS-approved sender title). Uses NetGSM's GET send API; it returns a
 * status code + job id as plain text — codes 00/01/02 mean accepted. Delivery
 * reports arrive separately on the public NetGSM DLR endpoint. Inbound MO
 * (mobile-originated replies) parse tolerantly since NetGSM's MO shape varies
 * by account.
 */
@Injectable()
export class NetgsmSmsAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'SMS' as const;
  readonly capabilities: readonly ChannelCapability[] = [
    'send',
    'receive',
    'delivery-receipts',
  ];
  private readonly logger = new Logger(NetgsmSmsAdapter.name);

  constructor(private readonly registry: ChannelAdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async send({ config, to, text }: OutboundSend): Promise<SendResult> {
    const { usercode, password, msgheader } = config.secrets;
    if (!usercode || !password || !msgheader) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: 'NetGSM channel not configured (usercode/password/msgheader)',
      };
    }
    const gsmno = to.replace(/[^\d]/g, '');
    const url =
      `https://api.netgsm.com.tr/sms/send/get?usercode=${encodeURIComponent(usercode)}` +
      `&password=${encodeURIComponent(password)}&gsmno=${encodeURIComponent(gsmno)}` +
      `&message=${encodeURIComponent(text)}&msgheader=${encodeURIComponent(msgheader)}`;
    try {
      const res = await fetch(url);
      const bodyText = (await res.text()).trim();
      const [code, jobId] = bodyText.split(/\s+/);
      // 00 = OK, 01/02 = OK for some account types; anything else is an error code.
      if (['00', '01', '02'].includes(code)) {
        return { externalMessageId: jobId ?? null, status: 'SENT' };
      }
      return { externalMessageId: null, status: 'FAILED', error: `NetGSM ${bodyText}` };
    } catch (e: any) {
      return { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
    }
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    // NetGSM MO callbacks differ by account; accept an array or {messages:[]} of
    // rows carrying a sender number + message text under a few common keys.
    const items: any[] = Array.isArray(body)
      ? body
      : ((body as any)?.messages ?? (body as any)?.data ?? []);
    const out: InboundMessage[] = [];
    for (const it of items) {
      const from = it?.msisdn ?? it?.no ?? it?.gsmno ?? it?.sender;
      const text = it?.message ?? it?.msg ?? it?.text ?? '';
      if (!from) continue;
      out.push({
        externalUserId: String(from),
        kind: 'PHONE',
        externalMessageId: it?.id != null ? String(it.id) : null,
        text: String(text),
        raw: it,
      });
    }
    return out;
  }

  async healthCheck(
    config: ResolvedChannelConfig,
  ): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    const { usercode, password, msgheader } = config.secrets;
    const ok = !!(usercode && password && msgheader);
    return { ok, details: { hasUsercode: !!usercode, hasHeader: !!msgheader } };
  }
}
