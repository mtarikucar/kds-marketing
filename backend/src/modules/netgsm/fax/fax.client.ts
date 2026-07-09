import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

type NetgsmCreds = { usercode: string; password: string };

export interface FaxSendRequest {
  /** Recipient fax number (fax-enabled line required on both ends). */
  to: string;
  /** The PDF/TIFF document to fax. Endpoint-level callers (`FaxSendService`)
   *  are responsible for the %PDF magic-byte + size guard BEFORE this is ever
   *  reached — this client trusts what it's handed, mirroring how
   *  `VoicesmsSendClient.upload` is the one place that validates .wav bytes
   *  while `send()`/`cancel()` don't re-check them. */
  document: Buffer;
  filename: string;
  /** Optional sender header/title line NetGSM prints on the cover — mirrors
   *  the SMS `msgheader` concept, fax-specific naming unconfirmed pending a
   *  live account (see the class docstring). */
  header?: string;
}

export interface FaxSendResult {
  ok: boolean;
  code: string;
  jobId: string | null;
  message: string | null;
  /** Only code '80' (rate limit) eases on its own — mirrors every other
   *  NetGSM send surface in this codebase. */
  retriable: boolean;
  /** True ONLY when the request never reached NetGSM at all (a thrown
   *  network/timeout error) — nothing was ever accepted, so a retry is safe.
   *  False for every other outcome, including a 200 whose body couldn't be
   *  parsed: NetGSM may already have queued/billed the fax job. Mirrors
   *  `SmsV2Client.doSend`/`VoicesmsSendClient.send`'s money-path idiom. */
  transport: boolean;
}

/** A normalized inbound fax row from `/fax/receive`. */
export interface FaxRow {
  /** NetGSM's own record id, when supplied (used for dedupe namespacing
   *  upstream by the Phase 6 Task 2 inbound poll — `netgsm-fax:<id>`). */
  id: string | null;
  /** Sender's fax number, as NetGSM reports it (unnormalized). */
  from: string;
  date: string | null;
  /** The document URL NetGSM hands back for the inbound fax (sesdosya-style
   *  tokenized link) — treat as a secret, never log raw. Whether this is kept
   *  as-is or re-hosted behind a tokened proxy is a Task 2 concern; this
   *  client only surfaces whatever NetGSM returns. */
  documentUrl: string | null;
}

export interface FaxReceiveResult {
  ok: boolean;
  /** NetGSM's own error code (e.g. "30" pre-auth/IP-not-allow-listed), when present. */
  code?: string;
  message?: string;
  rows: FaxRow[];
}

/** Sane pre-flight cap — NetGSM's own documented fax-size ceiling is
 *  unconfirmed pending a live account, so this is a conservative belt; the
 *  authoritative ~5MB limit is enforced earlier, at `POST /marketing/fax/send`
 *  (`FaxSendService`), before this client is ever called. Kept here too as
 *  defense-in-depth, mirroring `VoicesmsSendClient.upload`'s own MAX_UPLOAD_BYTES. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Only transient throttling (80) eases on its own — mirrors every other
 *  NetGSM send surface (SmsV2Client/VoicesmsSendClient). */
const RETRIABLE_CODES = new Set(['80']);

/**
 * NetGSM fax client (NetGSM Phase 6 Task 1) — the outbound `/fax/send`
 * (multipart: document + recipient + optional header → a fax job id) and the
 * inbound `/fax/receive` (date-ranged poll → inbound fax rows, each carrying a
 * document URL + sender). Fax-enabled number required on the account.
 *
 * Same host + transport philosophy as the sibling voice/voicemail clients
 * (`voicesms-send.client.ts` / `voicesms.client.ts`, both `api.netgsm.com.tr`):
 * raw `usercode`/`password` (send() as multipart form fields, receive() as a
 * JSON body — NOT the REST v2 Basic-Auth transport `NetgsmRestClient`
 * provides for `/sms/rest/v2/*`), tolerant multi-alias parsing (the real
 * field names are unconfirmed pending a live account — "researched, not yet
 * live-verified", same status the voice-campaign send/voicemail clients
 * carried before their own live confirmation), and the `{code, error}`
 * pre-auth/off-prod rejection envelope (HTTP 200). Never logs credentials — a
 * transport error's message can echo the request, so both cred values are
 * scrubbed before any log line.
 *
 * `receive()` has NO parameterless overload: `startdate`/`stopdate` are
 * required positional arguments (ddMMyyyyHHmm, ≤24h apart, same convention as
 * `VoicesmsClient.receiveVoicemails`), so a caller can never accidentally
 * request the server's default/entire-history window — see that client's
 * docstring for the "marks everything seen" hazard this signature is
 * designed to make impossible to trigger by accident here.
 *
 * The multipart field names sent on the wire (`dosya` for the document, `no`
 * for the recipient, `baslik` for the optional header) are our best-effort
 * match to NetGSM's Turkish-first classic-API naming (mirrors
 * `VoicesmsSendClient.upload`'s `dosya` field) and should be confirmed
 * against a live account before go-live; parsing the response stays tolerant
 * of aliases so the real field names slot in without a rewrite.
 */
@Injectable()
export class FaxClient {
  private readonly logger = new Logger(FaxClient.name);
  static readonly SEND_URL = 'https://api.netgsm.com.tr/fax/send';
  static readonly RECEIVE_URL = 'https://api.netgsm.com.tr/fax/receive';

  /** Send a fax document. Rejects an empty/oversize buffer BEFORE ever
   *  touching the network — mirrors `VoicesmsSendClient.upload`'s
   *  pre-flight-validate philosophy. */
  async send(creds: NetgsmCreds, req: FaxSendRequest): Promise<FaxSendResult> {
    if (!Buffer.isBuffer(req.document) || req.document.length === 0) {
      return {
        ok: false, code: '', jobId: null,
        message: 'Fakslanacak belge boş.', retriable: false, transport: false,
      };
    }
    if (req.document.length > MAX_DOCUMENT_BYTES) {
      return {
        ok: false, code: '', jobId: null,
        message: "Belge NetGSM'in fax boyut sınırını aşıyor.", retriable: false, transport: false,
      };
    }
    if (!req.to || !req.to.trim()) {
      return {
        ok: false, code: '', jobId: null,
        message: 'Alıcı faks numarası gerekli.', retriable: false, transport: false,
      };
    }

    const form = new FormData();
    form.append('usercode', creds.usercode);
    form.append('password', creds.password);
    form.append('no', req.to);
    form.append('dosya', new Blob([new Uint8Array(req.document)], { type: 'application/pdf' }), req.filename);
    if (req.header !== undefined) form.append('baslik', req.header);

    let respBody: any;
    try {
      const res = await safeFetch(FaxClient.SEND_URL, {
        method: 'POST',
        body: form,
        timeoutMs: 30_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      // A transport error's message can echo the request — scrub both cred
      // values before logging, mirrors VoicesmsSendClient/VoicesmsClient.
      this.logger.warn(`netgsm fax send transport error: ${this.scrub(e, creds)}`);
      return {
        ok: false, code: '', jobId: null,
        message: 'NetGSM faks isteğine ulaşılamadı.', retriable: false, transport: true,
      };
    }
    if (!respBody) {
      return {
        ok: false, code: '', jobId: null,
        message: 'NetGSM boş yanıt döndürdü.', retriable: false, transport: false,
      };
    }
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code == null) {
      // An HTTP response WAS received but carried no recognizable code —
      // NetGSM may already have queued the fax, so this must NOT be
      // retriable.
      return {
        ok: false, code: '', jobId: null,
        message: 'NetGSM beklenmedik yanıt döndürdü.', retriable: false, transport: false,
      };
    }
    if (code !== '00') {
      const message =
        typeof respBody.error === 'string' && respBody.error.trim()
          ? respBody.error.trim()
          : netgsmErrorMessage(code);
      this.logger.warn(`netgsm fax send error code=${code} ${message}`);
      return { ok: false, code, jobId: null, message, retriable: RETRIABLE_CODES.has(code), transport: false };
    }
    const jobId = pick(respBody, ['jobId', 'jobid', 'JobID', 'id']);
    return {
      ok: true, code, jobId: jobId != null ? String(jobId) : null,
      message: null, retriable: false, transport: false,
    };
  }

  /**
   * Normalized, tolerant, never-throws inbound-fax fetch. Never logs
   * credentials. `startdate`/`stopdate` are REQUIRED (ddMMyyyyHHmm) — see the
   * class docstring for why there is no parameterless form.
   */
  async receive(creds: NetgsmCreds, startdate: string, stopdate: string): Promise<FaxReceiveResult> {
    let body: any;
    try {
      const res = await safeFetch(FaxClient.RECEIVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usercode: creds.usercode, password: creds.password, startdate, stopdate }),
        timeoutMs: 20_000,
      });
      body = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm fax receive transport error: ${this.scrub(e, creds)}`);
      return { ok: false, rows: [], message: 'NetGSM faks alma isteğine ulaşılamadı.' };
    }
    if (!body) return { ok: false, rows: [], message: 'NetGSM boş yanıt döndürdü.' };
    // Error envelope: { code: "30"|..., error: "..." } (no records) — same
    // shape as the CDR/statistics/voicemail endpoints' pre-auth/off-prod
    // rejection.
    if (isErrorEnvelope(body)) {
      const code = String(body.code);
      const message = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : netgsmErrorMessage(code);
      this.logger.warn(`netgsm fax receive error code=${code} ${message}`);
      return { ok: false, rows: [], code, message };
    }
    return { ok: true, rows: normalizeFaxRows(body) };
  }

  /** Scrub both cred values out of a thrown transport error's message before
   *  it's ever logged — a timeout/DNS error can echo the request verbatim. */
  private scrub(e: any, creds: NetgsmCreds): string {
    return String(e?.message ?? e)
      .split(creds.password).join('***')
      .split(creds.usercode).join('***');
  }
}

const pick = (o: any, keys: string[]): any => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};

function isErrorEnvelope(body: any): boolean {
  if (Array.isArray(body) || !body || typeof body !== 'object') return false;
  if (body.code == null) return false;
  return (
    !Array.isArray(body.values) &&
    !Array.isArray(body.data) &&
    !Array.isArray(body.rows) &&
    !Array.isArray(body.faxes) &&
    !Array.isArray(body.records)
  );
}

/** Coerce the (array | keyed-object | {data:[]}/{rows:[]}/{faxes:[]}/{records:[]}/{values:[]}) response into rows. */
function toItems(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.rows)) return body.rows;
  if (Array.isArray(body?.faxes)) return body.faxes;
  if (Array.isArray(body?.records)) return body.records;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.values)) return body.values;
  if (body && typeof body === 'object') return Object.values(body).filter((v) => v && typeof v === 'object');
  return [];
}

function toFaxRow(raw: any): FaxRow | null {
  // Some shapes nest the fields under `values`.
  const o = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : raw;
  const id = pick(o, ['id', 'recordid', 'kayitid', 'faxid', 'jobid']);
  const from = pick(o, ['from', 'arayan', 'caller', 'no', 'gonderen', 'source']);
  if (id == null && from == null) return null; // nothing to key or attribute this row on
  return {
    id: id != null ? String(id) : null,
    from: from != null ? String(from) : '',
    date: pick(o, ['date', 'tarih', 'datetime']) ?? null,
    documentUrl: pick(o, ['documentUrl', 'dosya', 'belge', 'ses', 'url', 'file']) ?? null,
  };
}

function normalizeFaxRows(body: any): FaxRow[] {
  return toItems(body)
    .map(toFaxRow)
    .filter((r): r is FaxRow => r !== null);
}
