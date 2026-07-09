import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';

/** A normalized NetGSM voicemail (telesekreter) row. */
export interface VoicemailRow {
  /** NetGSM's own record id, when supplied (used for dedupe namespacing upstream). */
  id: string | null;
  /** Caller's number, as NetGSM reports it (unnormalized). */
  from: string;
  date: string | null;
  /** The `sesdosya.netgsm.com.tr` tokenized audio URL — treat as a secret, never log raw. */
  audioUrl: string | null;
  durationSec?: number;
}

export interface VoicemailReceiveResult {
  ok: boolean;
  /** NetGSM's own error code (e.g. "30" pre-auth/IP-not-allow-listed), when present. */
  code?: string;
  message?: string;
  voicemails: VoicemailRow[];
}

/**
 * NetGSM Netsantral voicemail (telesekreter) client — `/voicesms/receive`
 * over the standard NetGSM API (NetGSM Phase 4 Task 6).
 *
 * POST https://api.netgsm.com.tr/voicesms/receive (JSON: usercode, password,
 * startdate, stopdate in ddMMyyyyHHmm) -> voicemail rows, each carrying a
 * `sesdosya.netgsm.com.tr` audio URL. NetGSM documents this endpoint's window
 * as ≤24h — the CALLER (`NetgsmVoicemailPollService`) is responsible for
 * keeping the requested range within that bound and for polling at least
 * hourly so no voicemail ages out of the window unseen; this client does not
 * enforce either, mirroring how `NetgsmCdrClient`/`NetgsmStatisticsClient`
 * don't enforce their own windows either.
 *
 * There is intentionally NO parameterless overload: both `startdate` and
 * `stopdate` are required positional arguments, so a caller can never
 * accidentally omit the window the way `SmsV2Client.inbox`'s parameterless
 * form allows for the (unrelated) SMS inbox endpoint — see that client's
 * docstring for the server-side "marks everything seen" hazard this
 * signature is designed to make impossible to trigger by accident here.
 *
 * Same transport and caveats as the sibling CDR/statistics endpoints
 * (`netgsm-cdr.client.ts` / `netgsm-statistics.client.ts`, same
 * `api.netgsm.com.tr` host): raw `usercode`/`password` in a JSON POST body
 * (NOT the REST v2 Basic-Auth transport `NetgsmRestClient` provides for
 * `/sms/rest/v2/*`), tolerant multi-alias parsing (the real field names are
 * unconfirmed pending a live account, same "researched, not yet live-verified"
 * status statistics/queuestats carried before confirmation), and the
 * `{code, error}` pre-auth/off-prod rejection envelope (HTTP 200). Likely
 * IP-allow-listed to the production server like its siblings, so a local/
 * staging call may authenticate-reject regardless of credential validity.
 * Rate-limited by NetGSM to 2 req/min per account — the CALLER budgets that
 * via `AccountRateBudgeter('voicemail')`, not this client (mirrors every
 * other budgeted NetGSM surface in this codebase).
 */
@Injectable()
export class VoicesmsClient {
  private readonly logger = new Logger(VoicesmsClient.name);
  static readonly URL = 'https://api.netgsm.com.tr/voicesms/receive';

  /** Raw NetGSM response (for diagnosis — lets us see real fields once confirmed live). */
  async fetchRaw(
    creds: { usercode: string; password: string },
    startdate: string,
    stopdate: string,
  ): Promise<{ httpStatus: number; body: any }> {
    const res = await safeFetch(VoicesmsClient.URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usercode: creds.usercode, password: creds.password, startdate, stopdate }),
      timeoutMs: 20_000,
    });
    const body = await res.json().catch(() => null);
    return { httpStatus: res.status, body };
  }

  /**
   * Normalized, tolerant, never-throws voicemail fetch. Never logs credentials.
   * `startdate`/`stopdate` are REQUIRED (ddMMyyyyHHmm, ≤24h apart) — see the
   * class docstring for why there is no parameterless form.
   */
  async receiveVoicemails(
    creds: { usercode: string; password: string },
    startdate: string,
    stopdate: string,
  ): Promise<VoicemailReceiveResult> {
    let body: any;
    try {
      ({ body } = await this.fetchRaw(creds, startdate, stopdate));
    } catch (e: any) {
      // A transport error's message can echo the POST body (usercode/password).
      // Scrub both cred values before logging — mirrors NetgsmCdrClient/NetgsmStatisticsClient.
      const raw = String(e?.message ?? e);
      const scrubbed = raw
        .split(creds.password).join('***')
        .split(creds.usercode).join('***');
      this.logger.warn(`netgsm voicemail fetch failed: ${scrubbed}`);
      return { ok: false, voicemails: [], message: 'Netsantral voicemail request failed' };
    }
    if (!body) return { ok: false, voicemails: [], message: 'Netsantral returned an empty response' };
    // Error envelope: { code: "30"|"331"|..., error: "..." } (no records) — same
    // shape as the CDR/statistics endpoints' pre-auth/off-prod rejection.
    if (isErrorEnvelope(body)) {
      const code = String(body.code);
      const message = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : undefined;
      this.logger.warn(`netgsm voicemail error code=${code} ${message ?? ''}`);
      return { ok: false, voicemails: [], code, message };
    }
    return { ok: true, voicemails: normalizeVoicemails(body) };
  }
}

function isErrorEnvelope(body: any): boolean {
  if (Array.isArray(body) || !body || typeof body !== 'object') return false;
  if (body.code == null) return false;
  return (
    !Array.isArray(body.values) &&
    !Array.isArray(body.data) &&
    !Array.isArray(body.voicemails) &&
    !Array.isArray(body.records)
  );
}

const pick = (o: any, keys: string[]): any => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};

/** Coerce the (array | keyed-object | {data:[]}/{voicemails:[]}/{records:[]}/{values:[]}) response into rows. */
function toItems(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.voicemails)) return body.voicemails;
  if (Array.isArray(body?.records)) return body.records;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.values)) return body.values;
  if (body && typeof body === 'object') return Object.values(body).filter((v) => v && typeof v === 'object');
  return [];
}

function toVoicemailRow(raw: any): VoicemailRow | null {
  // Some shapes nest the fields under `values`.
  const o = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : raw;
  const id = pick(o, ['id', 'recordid', 'kayitid', 'gorevid', 'msgid']);
  const from = pick(o, ['from', 'arayan', 'caller', 'no', 'source', 'ceptel']);
  if (id == null && from == null) return null; // nothing to key or attribute this row on
  const durRaw = pick(o, ['durationSec', 'sure', 'süre', 'duration']);
  const durationSec = durRaw != null && Number.isFinite(Number(durRaw)) ? Number(durRaw) : undefined;
  return {
    id: id != null ? String(id) : null,
    from: from != null ? String(from) : '',
    date: pick(o, ['date', 'tarih', 'datetime']) ?? null,
    audioUrl: pick(o, ['audioUrl', 'sesdosya', 'ses', 'url', 'recording', 'file']) ?? null,
    ...(durationSec != null ? { durationSec } : {}),
  };
}

function normalizeVoicemails(body: any): VoicemailRow[] {
  return toItems(body)
    .map(toVoicemailRow)
    .filter((r): r is VoicemailRow => r !== null);
}
