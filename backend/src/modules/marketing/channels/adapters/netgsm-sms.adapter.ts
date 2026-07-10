import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { withRetry } from '../../../../common/retry.util';
import { interpretNetgsmSend } from '../netgsm-send.util';
import { BalanceClient } from '../../../netgsm/balance/balance.client';
import { SmsV2Client } from '../../../netgsm/sms/sms-v2.client';
import {
  ChannelAdapter,
  ChannelCapability,
  InboundMessage,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
} from '../channel-adapter.interface';

type NetgsmCreds = { usercode: string; password: string };
/** Shared shape for a single send attempt: the public SendResult plus whether
 *  THIS particular failure is worth retrying (never surfaced to the caller). */
type SendAttempt = SendResult & { retriable: boolean };

/**
 * NetGSM SMS adapter. Secrets: { usercode, password, msgheader } (msgheader is
 * the İYS-approved sender title). Sends via NetGSM's REST v2 `send` endpoint
 * (true n:n bulk, JSON, Basic Auth) by default; a channel can opt back into the
 * legacy `/sms/send/get` GET API via `configPublic.useLegacySend === true`
 * while its account bakes on v2. Delivery reports arrive separately (DLR poll,
 * Task 6). Inbound MO (mobile-originated replies) parse tolerantly since
 * NetGSM's MO shape varies by account.
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

  constructor(
    private readonly registry: ChannelAdapterRegistry,
    private readonly balance: BalanceClient,
    private readonly smsV2: SmsV2Client,
  ) {}

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
    const creds: NetgsmCreds = { usercode, password };

    // Per-channel escape hatch back to the legacy GET API; every other value
    // (absent, false) sends via REST v2 — see netgsm-config.util.ts.
    if (config.public?.useLegacySend === true) {
      return this.runWithRetry(() => this.attemptLegacy(creds, msgheader, gsmno, text));
    }
    return this.runWithRetry(() => this.attemptV2(creds, msgheader, gsmno, text));
  }

  /** One legacy `/sms/send/get` attempt. Transient failures (network/timeout/
   *  HTTP-5xx) throw so the retry wrapper backs off; a parsed provider error
   *  returns a structured outcome carrying whether it's worth retrying (only
   *  the rate-limit code 80). */
  private async attemptLegacy(
    creds: NetgsmCreds,
    msgheader: string,
    gsmno: string,
    text: string,
  ): Promise<SendAttempt> {
    // Credentials go in the POST body (form-encoded), never the URL/query
    // string, so they don't leak into proxy/access logs or error messages.
    const form = new URLSearchParams({
      usercode: creds.usercode,
      password: creds.password,
      gsmno,
      message: text,
      msgheader,
    });
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
  }

  /** One REST v2 `send` attempt (single-recipient call — CampaignSenderService's
   *  n:n batching is Task 5). `SmsV2Client.send` never throws: every failure
   *  (transport, unexpected response, provider error code) resolves to an
   *  `ok:false` result, so retriability is read off the result rather than a
   *  caught exception. Retriable = code 80 (rate limit, same as legacy) OR
   *  `result.transport` (a genuine transport/timeout failure — the request
   *  never reached NetGSM, so nothing was sent and a retry is safe). Crucially
   *  this does NOT retry merely on an empty `code`: an HTTP response that came
   *  back but couldn't be parsed means NetGSM may already have accepted and
   *  sent the message, and retrying that would risk billing/sending a
   *  duplicate SMS — mirroring attemptLegacy's "network + HTTP-5xx + code 80
   *  retries, everything else (including a received-but-unparseable
   *  response) is final" rule one level up the stack. */
  private async attemptV2(
    creds: NetgsmCreds,
    msgheader: string,
    gsmno: string,
    text: string,
  ): Promise<SendAttempt> {
    const result = await this.smsV2.send(creds, {
      msgheader,
      messages: [{ msg: text, no: gsmno }],
    });
    if (result.ok) {
      return { externalMessageId: result.jobid, status: 'SENT', retriable: false };
    }
    return {
      externalMessageId: null,
      status: 'FAILED',
      error: result.message ?? `NetGSM ${result.code || '?'}`,
      retriable: result.retriable || result.transport,
    };
  }

  /** Shared bounded-retry wrapper for both send paths — one place defines
   *  "what counts as retriable" so legacy and v2 truly share retry semantics
   *  instead of two independently-maintained copies. MUST NOT throw (the
   *  ChannelAdapter contract): a stray exception collapses to a scrubbed
   *  FAILED result instead of propagating. */
  private async runWithRetry(attempt: () => Promise<SendAttempt>): Promise<SendResult> {
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

  /** Live verify: presence check, then a real /balance auth probe (not
   *  IP-gated), then — only once creds are confirmed live — a msgheader-list
   *  check so "Verify" also catches a header that's live but NOT İYS-approved
   *  (a distinct failure from bad credentials, surfaced as
   *  `details.headerApproved`). The msgheader list is cached onto
   *  `details.approvedHeaders` for the settings UI's header dropdown. */
  async healthCheck(
    config: ResolvedChannelConfig,
  ): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    const { usercode, password, msgheader } = config.secrets;
    if (!usercode || !password || !msgheader) {
      return { ok: false, details: { hasUsercode: !!usercode, hasHeader: !!msgheader } };
    }
    const probe = await this.balance.fetchBalance({ usercode, password });
    // Bad/unreachable creds short-circuit exactly as before — never spend a
    // second live call confirming a header on an account we can't even reach.
    if (probe.credsValid !== true) {
      return {
        ok: false,
        details: {
          credsValid: probe.credsValid,
          credit: probe.credit,
          code: probe.code,
          message: probe.message,
          hasHeader: true,
        },
      };
    }
    const details: Record<string, unknown> = {
      credsValid: probe.credsValid,
      credit: probe.credit,
      code: probe.code,
      message: probe.message,
      hasHeader: true,
    };
    const headersResult = await this.smsV2.msgheaders({ usercode, password });
    if (!headersResult.ok) {
      // The msgheader-list endpoint hiccuped — creds are live, so don't fail
      // verify over a second, unrelated endpoint being flaky; headerApproved
      // simply stays unset (undefined) rather than a false negative.
      return { ok: true, details };
    }
    details.approvedHeaders = headersResult.headers;
    const headerApproved = headersResult.headers.includes(msgheader);
    details.headerApproved = headerApproved;
    return { ok: headerApproved, details };
  }
}
