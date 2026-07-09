import { Injectable, Logger } from '@nestjs/common';
import { interpretNetsantralOriginate, NetsantralOriginateOutcome } from './netsantral.util';

export interface OriginateParams {
  username: string;
  password: string;
  customer_num: string;
  internal_num: string;
  trunk: string;
  pbxnum?: string;
  /** Correlation id echoed on call-event webhooks (Phase 2); use the SalesCall id. */
  crmId?: string;
  /** Ring duration (seconds) before giving up on the rep's extension. */
  ringTimeout?: number;
  /** Record both legs (caller_record/called_record). Mirrors BridgeParams.record. */
  record?: boolean;
}

export interface BridgeParams {
  username: string;
  password: string;
  /** First leg — the rep's own phone (external number). NetGSM rings this first. */
  caller: string;
  /** Second leg — the customer/lead number. */
  called: string;
  trunk: string;
  /** Correlation id echoed on call-event webhooks/CDR (Phase 2); use the SalesCall id. */
  crmId?: string;
  ringTimeout?: number;
  /** Record both legs (caller_record/called_record). Retrieval is via the report API. */
  record?: boolean;
}

/** Netsantral account credentials — the subset every control endpoint needs. */
export interface NetsantralCreds {
  username: string;
  password: string;
}

/**
 * Thin client for NetGSM Netsantral call control ("dış arama" / tıkla-ara).
 *
 * Two ways to place a call (endpoints confirmed from the official
 * `netgsm1/netsantral` package source, host `crmsntrl.netgsm.com.tr:9111`):
 *  - originate (`/originate`, cagribaslat): rings the rep's EXTENSION first, then
 *    the customer. Needs a registered device on that extension (webphone/Netsipp).
 *  - callBridge (`/linkup`, cagribagla): rings the rep's own PHONE and the customer
 *    as two external legs and bridges them over the trunk — needs NO extension, so
 *    it works without Netsipp. `originate_order=if` rings the rep (caller) first.
 *
 * Both show the trunk (0850) as the caller id, so the customer sees the business
 * number and the rep's personal number stays hidden.
 *
 * SECURITY: this PBX endpoint is plain HTTP (port 9111) and takes credentials in
 * the query string — NetGSM's design, not ours. So we NEVER log the URL and we
 * scrub username+password from any error. Inert until a workspace has an ACTIVE
 * TelephonyConfig.
 */
@Injectable()
export class NetsantralClient {
  private readonly logger = new Logger(NetsantralClient.name);
  static readonly ORIGINATE_HOST = 'http://crmsntrl.netgsm.com.tr:9111';
  private static readonly TIMEOUT_MS = 15_000;
  private static readonly DEFAULT_RING_TIMEOUT = 30;

  /** Ring the rep's extension first, then the customer (api-dial; needs a device on the extension). */
  async originate(p: OriginateParams): Promise<NetsantralOriginateOutcome> {
    if (!p?.username || !p?.password || !p?.customer_num || !p?.internal_num || !p?.trunk) {
      return { ok: false, message: 'Netsantral originate called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: p.username,
      password: p.password,
      customer_num: p.customer_num.replace(/[^\d]/g, ''),
      pbxnum: p.pbxnum ?? '',
      internal_num: p.internal_num,
      ring_timeout: String(p.ringTimeout ?? NetsantralClient.DEFAULT_RING_TIMEOUT),
      crm_id: p.crmId ?? '',
      wait_response: '0',
      // ring the rep's extension first, then the customer (matches the package default)
      originate_order: 'if',
      trunk: p.trunk.replace(/[^\d]/g, ''),
    });
    if (p.record) {
      qs.set('caller_record', '1');
      qs.set('called_record', '1');
    }
    return this.call('originate', p.username, qs, p.password);
  }

  /**
   * Bridge two external numbers: ring the rep's own phone (`caller`) and the
   * customer (`called`), connect them over the trunk. No extension/softphone
   * needed — the no-Netsipp click-to-call path.
   */
  async callBridge(p: BridgeParams): Promise<NetsantralOriginateOutcome> {
    if (!p?.username || !p?.password || !p?.caller || !p?.called || !p?.trunk) {
      return { ok: false, message: 'Netsantral callBridge called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: p.username,
      password: p.password,
      caller: p.caller.replace(/[^\d]/g, ''),
      called: p.called.replace(/[^\d]/g, ''),
      ring_timeout: String(p.ringTimeout ?? NetsantralClient.DEFAULT_RING_TIMEOUT),
      crm_id: p.crmId ?? '',
      wait_response: '0',
      // ring the rep (caller/first leg) first, then the customer
      originate_order: 'if',
      trunk: p.trunk.replace(/[^\d]/g, ''),
    });
    if (p.record) {
      qs.set('caller_record', '1');
      qs.set('called_record', '1');
    }
    return this.call('linkup', p.username, qs, p.password);
  }

  /**
   * Hang up the LIVE call (Phase 3 Task 5 — in-call controls). Needs the
   * santral `unique_id`, which only arrives later via the event webhook and
   * gets backfilled onto `SalesCall.externalCallId` (see
   * TelephonyEventConsumer) — there is no way to hang up a call before that.
   */
  async hangup(creds: NetsantralCreds, uniqueId: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId) {
      return { ok: false, message: 'Netsantral hangup called with missing parameters.' };
    }
    const qs = new URLSearchParams({ username: creds.username, password: creds.password, unique_id: uniqueId });
    return this.call('hangup', creds.username, qs, creds.password);
  }

  /** Blind transfer (`xfer`) — hand the LIVE call off to another extension, this leg drops immediately. */
  async blindTransfer(creds: NetsantralCreds, uniqueId: string, exten: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId || !exten) {
      return { ok: false, message: 'Netsantral blindTransfer called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: creds.username, password: creds.password, unique_id: uniqueId, exten,
    });
    return this.call('xfer', creds.username, qs, creds.password);
  }

  /** Attended transfer (`atxfer`) — consult the target extension before the handoff completes. */
  async attendedTransfer(creds: NetsantralCreds, uniqueId: string, exten: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId || !exten) {
      return { ok: false, message: 'Netsantral attendedTransfer called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: creds.username, password: creds.password, unique_id: uniqueId, exten,
    });
    return this.call('atxfer', creds.username, qs, creds.password);
  }

  /**
   * Mute/unmute (`muteaudio`) one side of the LIVE call. NOTE: the exact
   * on/off toggle field is an open item (same status as originate/linkup's
   * wire shape before it was confirmed live — see the class docstring) —
   * `mute=1|0` is the best-effort guess; adjust here if NetGSM's real field
   * differs once confirmed against a live account.
   */
  async mute(creds: NetsantralCreds, uniqueId: string, on: boolean): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId) {
      return { ok: false, message: 'Netsantral mute called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: creds.username, password: creds.password, unique_id: uniqueId, mute: on ? '1' : '0',
    });
    return this.call('muteaudio', creds.username, qs, creds.password);
  }

  /** Shared GET + status check + tolerant interpret + credential scrubbing. */
  private async call(
    path: 'originate' | 'linkup' | 'hangup' | 'xfer' | 'atxfer' | 'muteaudio',
    username: string,
    qs: URLSearchParams,
    password: string,
  ): Promise<NetsantralOriginateOutcome> {
    try {
      const url = `${NetsantralClient.ORIGINATE_HOST}/${encodeURIComponent(username)}/${path}?${qs.toString()}`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(NetsantralClient.TIMEOUT_MS),
      });
      if (typeof res.status === 'number' && res.status >= 400) {
        // never log the url — it carries the credentials in the query string
        this.logger.warn(`netsantral ${path} HTTP ${res.status}`);
        return { ok: false, message: `Netsantral HTTP ${res.status}` };
      }
      const text = (await res.text()) ?? '';
      const outcome = interpretNetsantralOriginate(text);
      if (!outcome.ok) {
        // Make the real wire shape visible for diagnosis WITHOUT leaking PII:
        // mask any 7+ digit run (phone numbers/msisdn) and cap length. Creds live
        // in the query string, not the body, so the body is otherwise safe to log.
        const safeBody = text.replace(/\d{7,}/g, '***').slice(0, 500);
        this.logger.warn(`netsantral ${path} not ok: ${outcome.message ?? outcome.code ?? '?'} | body=${safeBody}`);
      }
      return outcome;
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'Netsantral request timed out' : (e?.message ?? String(e));
      // The URL carries username+password in the query — scrub both from any error.
      const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scrubbed = raw
        .replace(/password=[^&\s]+/gi, 'password=***')
        .replace(/username=[^&\s]+/gi, 'username=***')
        .replace(new RegExp(escaped, 'g'), '***');
      return { ok: false, message: scrubbed };
    }
  }
}
