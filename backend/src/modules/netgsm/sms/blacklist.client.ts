import { Injectable, Logger } from '@nestjs/common';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

export interface BlacklistResult {
  ok: boolean;
  /** Bare status code NetGSM returned ('' when the response was empty/unparseable). */
  code: string;
  /** Human-actionable message; null on success. */
  message: string | null;
}

/**
 * NetGSM's legacy "kara liste" (blacklist) API — POST /sms/blacklist, a
 * write-only endpoint (there is no read/list API): `add` blocks all future
 * sends to a number from this NetGSM account, `remove` un-blocks it.
 *
 * This is defense-in-depth ONLY. The app's own smsOptOut checks
 * (campaign-sender.service.ts, workflow-action.handler.ts) plus İYS are the
 * PRIMARY enforcement; this client mirrors that state onto NetGSM's
 * account-level blocklist so a bypass of the app-side gate still can't reach
 * an opted-out number. See netgsm-blacklist-sync.service.ts for the consumer
 * that drives add/remove off lead opt-out/opt-in transitions.
 *
 * Wire format is NetGSM's legacy XML convention (distinct from the REST v2
 * JSON surface): `Content-Type: text/xml`, credentials INSIDE the XML body
 * (not the URL/query string, not Basic Auth — NetGSM's design, not ours).
 * The response is a bare status-code line, same shape as the legacy send API
 * ("00" success, anything else an error code) — parsed tolerantly the same
 * way.
 *
 * SECURITY: never log the request XML or response rawText verbatim (the XML
 * carries usercode+password in plaintext); a thrown transport error is
 * defensively scrubbed in case it ever echoes the request body.
 */
@Injectable()
export class BlacklistClient {
  private readonly logger = new Logger(BlacklistClient.name);
  private static readonly URL = 'https://api.netgsm.com.tr/sms/blacklist';
  private static readonly TIMEOUT_MS = 15_000;

  /** Add a number to the account's blacklist (tip=1) — blocks all future sends to it. */
  async add(creds: { usercode: string; password: string }, msisdn: string): Promise<BlacklistResult> {
    return this.call(creds, msisdn, '1');
  }

  /** Remove a number from the account's blacklist (tip=2) — allows sends to it again. */
  async remove(creds: { usercode: string; password: string }, msisdn: string): Promise<BlacklistResult> {
    return this.call(creds, msisdn, '2');
  }

  private async call(
    creds: { usercode: string; password: string },
    msisdn: string,
    tip: '1' | '2',
  ): Promise<BlacklistResult> {
    if (!creds?.usercode || !creds?.password) {
      return { ok: false, code: '', message: 'NetGSM blacklist called with missing credentials' };
    }
    const no = toLocalMsisdn(msisdn);
    if (!no) {
      return { ok: false, code: '', message: `NetGSM blacklist called with an invalid number: ${redactPhone(msisdn)}` };
    }
    // Credentials ride INSIDE the XML body per NetGSM's legacy convention —
    // this string is never logged (see class docstring).
    const xml =
      '<?xml version="1.0"?>' +
      '<mainbody>' +
      '<header>' +
      `<usercode>${escapeXml(creds.usercode)}</usercode>` +
      `<password>${escapeXml(creds.password)}</password>` +
      `<type>${tip}</type>` +
      '</header>' +
      '<body>' +
      `<no>${no}</no>` +
      '</body>' +
      '</mainbody>';
    try {
      const res = await fetch(BlacklistClient.URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml,
        signal: AbortSignal.timeout(BlacklistClient.TIMEOUT_MS),
      });
      const rawText = ((await res.text()) ?? '').trim();
      // Bare-code response ("00", "30", ...) — mirror interpretNetgsmSend's
      // parsing style (first whitespace-delimited token is the code).
      const code = rawText.split(/\s+/)[0] ?? '';
      if (code === '00') {
        return { ok: true, code, message: null };
      }
      return {
        ok: false,
        code,
        message: code ? netgsmErrorMessage(code) : 'NetGSM blacklist returned an empty response',
      };
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'NetGSM blacklist request timed out' : (e?.message ?? String(e));
      const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scrubbed = raw
        .replace(new RegExp(escapeRegex(creds.password), 'g'), '***')
        .replace(new RegExp(escapeRegex(creds.usercode), 'g'), '***');
      return { ok: false, code: '', message: scrubbed };
    }
  }
}

/** Normalise any Turkish mobile shape (+90, 0-prefixed, bare 10-digit) to the
 *  bare 10-digit local MSISDN NetGSM's blacklist body expects ("5xxxxxxxxx").
 *  Returns '' when the input can't be reduced to a 10-digit number. */
function toLocalMsisdn(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : '';
}

/** Mask a phone number in an error message — never echo full MSISDNs in logs. */
function redactPhone(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d ? `***${d.slice(-2)}` : '(empty)';
}

function escapeXml(s: string): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
