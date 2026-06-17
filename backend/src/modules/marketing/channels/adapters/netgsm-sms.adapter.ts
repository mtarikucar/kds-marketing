import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { withRetry } from '../../../../common/retry.util';
import { interpretNetgsmSend } from '../netgsm-send.util';
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

  private static readonly SEND_URL = 'https://api.netgsm.com.tr/sms/send/get';
  private static readonly TIMEOUT_MS = 15_000;
  private static readonly MAX_ATTEMPTS = 3;
  private static readonly BACKOFF_BASE_MS = 300;
  /** Cap rows per inbound callback so one request can't fan out to thousands of
   *  ingest transactions (a real MO POST carries a single reply). */
  private static readonly MAX_INBOUND_BATCH = 100;

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

    // One send attempt. Transient failures (network/timeout/HTTP-5xx) throw so
    // the retry wrapper backs off; a parsed provider error returns a structured
    // outcome carrying whether it's worth retrying (only the rate-limit code 80).
    type Attempt = SendResult & { retriable: boolean };
    const attempt = async (): Promise<Attempt> => {
      // Credentials go in the POST body (form-encoded), never the URL/query
      // string, so they don't leak into proxy/access logs or error messages.
      const form = new URLSearchParams({ usercode, password, gsmno, message: text, msgheader });
      const res = await fetch(NetgsmSmsAdapter.SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        // Bound every call so a hung connection can't block a campaign batch
        // (which is then reaped and double-sent) — the abort is a transient throw.
        signal: AbortSignal.timeout(NetgsmSmsAdapter.TIMEOUT_MS),
      });
      if (typeof res.status === 'number' && res.status >= 500) {
        throw new Error(`NetGSM HTTP ${res.status}`); // transient → retry
      }
      const outcome = interpretNetgsmSend((await res.text()) ?? '');
      if (outcome.ok) {
        return { externalMessageId: outcome.jobId, status: 'SENT', retriable: false };
      }
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: outcome.message ?? `NetGSM ${outcome.code}`,
        retriable: outcome.retriable,
      };
    };

    try {
      const result = await withRetry(attempt, {
        attempts: NetgsmSmsAdapter.MAX_ATTEMPTS,
        shouldRetry: ({ result, error }) => (error !== undefined ? true : !!result?.retriable),
        delayMs: (n) => NetgsmSmsAdapter.BACKOFF_BASE_MS * 2 ** (n - 1),
      });
      const { retriable: _retriable, ...sendResult } = result;
      return sendResult;
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'NetGSM request timed out' : (e?.message ?? String(e));
      // Defensive scrub: never echo the password if it surfaced in an error.
      const scrubbed = raw.replace(/password=[^&\s]+/gi, 'password=***');
      return { externalMessageId: null, status: 'FAILED', error: scrubbed };
    }
  }

  parseInbound(_config: ResolvedChannelConfig, body: unknown): InboundMessage[] {
    // NetGSM's interactive-SMS "URL'ye yönlendir" posts JSON with fields
    // { mesaj, ceptel, aboneno, gorevid, tarih } (per the official netgsm1/sms
    // package). It posts one object per reply; we also tolerate a batched array
    // or {messages|data:[]} and the older key spellings, so an account whose
    // shape differs slightly still ingests.
    const rows: any[] = Array.isArray(body)
      ? body
      : Array.isArray((body as any)?.messages)
        ? (body as any).messages
        : Array.isArray((body as any)?.data)
          ? (body as any).data
          : body && typeof body === 'object'
            ? [body]
            : [];
    if (rows.length > NetgsmSmsAdapter.MAX_INBOUND_BATCH) {
      this.logger.warn(
        `netgsm MO batch of ${rows.length} rows capped to ${NetgsmSmsAdapter.MAX_INBOUND_BATCH}`,
      );
    }
    const out: InboundMessage[] = [];
    for (const row of rows.slice(0, NetgsmSmsAdapter.MAX_INBOUND_BATCH)) {
      const sender = row?.ceptel ?? row?.msisdn ?? row?.no ?? row?.gsmno ?? row?.sender;
      if (!sender) continue;
      const text = row?.mesaj ?? row?.message ?? row?.msg ?? row?.text ?? '';
      const id = row?.gorevid ?? row?.id;
      out.push({
        externalUserId: this.normalizeMsisdn(String(sender)),
        kind: 'PHONE',
        // Namespace inbound ids: a NetGSM gorevid is a bare number that could
        // otherwise collide with an outbound bulkid in the unique column.
        externalMessageId: id != null ? `netgsm-mo:${id}` : null,
        text: String(text),
        raw: row,
      });
    }
    return out;
  }

  /** Normalise a Turkish mobile to E.164 (+90…) so inbound senders and outbound
   *  recipients map to one ContactIdentity regardless of how the number arrived. */
  private normalizeMsisdn(raw: string): string {
    let d = (raw ?? '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) return `+90${d}`;
    return d ? `+${d}` : '';
  }

  async healthCheck(
    config: ResolvedChannelConfig,
  ): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    const { usercode, password, msgheader } = config.secrets;
    const ok = !!(usercode && password && msgheader);
    return { ok, details: { hasUsercode: !!usercode, hasHeader: !!msgheader } };
  }
}
