import { Injectable, Logger } from '@nestjs/common';
import { NetgsmRestClient } from '../core/netgsm-rest.client';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

export type IysConsentType = 'MESAJ' | 'ARAMA' | 'EPOSTA';

export interface IysConsentRow {
  recipient: string;
  type: IysConsentType;
  status: 'ONAY' | 'RET';
  /** İYS timestamp of the consent event ('YYYY-MM-DD HH:mm:ss'). */
  consentDate: string;
  /** İYS source code, e.g. HS_WEB / HS_MESAJ. */
  source: string;
  /** Set only when re-submitting/correcting a row İYS already assigned a refid to. */
  refid?: string;
}

export interface IysAddResult {
  ok: boolean;
  code: string;
  refids: string[];
  message: string | null;
}

export interface IysSearchResult {
  ok: boolean;
  status: 'ONAY' | 'RET' | 'YOK' | null;
  message: string | null;
}

export interface IysWebhookResult {
  ok: boolean;
  code: string;
  message: string | null;
}

export type IysCreds = { usercode: string; password: string; brandCode: string };

/** İYS batches are capped at 500 rows/call; the caller (IysSyncJob worker) chunks. */
const IYS_ADD_MAX_ROWS = 500;

const CONSENT_STATUSES = new Set(['ONAY', 'RET', 'YOK']);

/**
 * İYS (İleti Yönetim Sistemi) hub client — batch-submits consent proof
 * (`/iys/add`), queries consent state pre-send (`/iys/search`), and registers
 * the push-back webhook (`/iys/webhook`). Same NetGSM API host as the other
 * REST v2 surfaces; transport, Basic Auth and credential scrubbing are owned
 * entirely by `NetgsmRestClient`.
 *
 * İYS's OWN auth convention layers on top of Basic Auth: every request body
 * carries a `header: {username, password, brandCode}` object (username =
 * the same usercode used for Basic Auth; brandCode = the tenant's İYS marka
 * kodu). That header object contains the plaintext password, so — like
 * `BlacklistClient`'s credential-bearing XML body — it must NEVER be logged;
 * this class only ever logs `e.message`, which `NetgsmRestClient` has
 * already scrubbed of both usercode and password.
 *
 * `/iys/add` is documented ASYNC: the response acknowledges receipt and
 * hands back a `refid` per submitted row (final ONAY/RET confirmation
 * arrives later via poll or the webhook). Real-world response casing for
 * that per-row array and its refid key varies across NetGSM's docs
 * revisions/accounts, so both are parsed tolerantly, mirroring
 * `SmsV2Client.report`'s referansID/referansId/referans tolerance.
 */
@Injectable()
export class IysClient {
  private readonly logger = new Logger(IysClient.name);

  constructor(private readonly rest: NetgsmRestClient) {}

  /** Caller chunks rows to ≤500 per call; this defensively rejects an oversized
   *  batch itself rather than sending it and letting NetGSM reject it. */
  async add(creds: IysCreds, rows: IysConsentRow[]): Promise<IysAddResult> {
    if (rows.length > IYS_ADD_MAX_ROWS) {
      return {
        ok: false, code: '', refids: [],
        message: `İYS toplu ekleme çağrı başına en fazla ${IYS_ADD_MAX_ROWS} kayıt kabul eder (gönderilen: ${rows.length}).`,
      };
    }
    const body = {
      header: this.header(creds),
      iysRecipients: rows.map((r) => {
        const wire: Record<string, unknown> = {
          recipient: r.recipient, type: r.type, status: r.status,
          consentDate: r.consentDate, source: r.source,
        };
        if (r.refid != null) wire.refid = r.refid;
        return wire;
      }),
    };
    let httpStatus: number, respBody: any, rawText: string;
    try {
      ({ httpStatus, body: respBody, rawText } = await this.rest.request({
        path: '/iys/add', method: 'POST', creds: this.basicCreds(creds), body,
      }));
    } catch (e: any) {
      // Message is already cred-scrubbed by NetgsmRestClient — safe to log/return.
      this.logger.warn(`netgsm iys/add transport error: ${e?.message ?? e}`);
      return { ok: false, code: '', refids: [], message: e?.message ?? 'NetGSM erişilemedi' };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null) {
      return {
        ok: false, code: '', refids: [],
        message: `NetGSM beklenmedik yanıt döndürdü (HTTP ${httpStatus}).`,
      };
    }
    if (code !== '00') {
      return { ok: false, code, refids: [], message: netgsmErrorMessage(code) };
    }
    return { ok: true, code, refids: this.extractRefids(respBody), message: null };
  }

  /** Pre-send consent lookup for ONE recipient+type. `YOK` means İYS holds no
   *  record at all for that recipient — treated as "no permission" for TİCARİ
   *  sends by the campaign preflight (owner decision, Phase 2 Task 5). */
  async search(creds: IysCreds, recipient: string, type: IysConsentType): Promise<IysSearchResult> {
    const body = { header: this.header(creds), recipient, type };
    let httpStatus: number, respBody: any, rawText: string;
    try {
      ({ httpStatus, body: respBody, rawText } = await this.rest.request({
        path: '/iys/search', method: 'POST', creds: this.basicCreds(creds), body,
      }));
    } catch (e: any) {
      this.logger.warn(`netgsm iys/search transport error: ${e?.message ?? e}`);
      return { ok: false, status: null, message: e?.message ?? 'NetGSM erişilemedi' };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null) {
      return { ok: false, status: null, message: `NetGSM beklenmedik yanıt döndürdü (HTTP ${httpStatus}).` };
    }
    if (code !== '00') {
      return { ok: false, status: null, message: netgsmErrorMessage(code) };
    }
    return { ok: true, status: this.extractConsentStatus(respBody), message: null };
  }

  /** Registers the push-back URL that İYS will POST consent changes to
   *  (Phase 2 Task 4's unified receiver, `netgsmWebhookUrl(base, workspaceId, 'iys')`). */
  async registerWebhook(creds: IysCreds, url: string): Promise<IysWebhookResult> {
    const body = { header: this.header(creds), url };
    let httpStatus: number, respBody: any, rawText: string;
    try {
      ({ httpStatus, body: respBody, rawText } = await this.rest.request({
        path: '/iys/webhook', method: 'POST', creds: this.basicCreds(creds), body,
      }));
    } catch (e: any) {
      this.logger.warn(`netgsm iys/webhook transport error: ${e?.message ?? e}`);
      return { ok: false, code: '', message: e?.message ?? 'NetGSM erişilemedi' };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null) {
      return { ok: false, code: '', message: `NetGSM beklenmedik yanıt döndürdü (HTTP ${httpStatus}).` };
    }
    if (code !== '00') {
      return { ok: false, code, message: netgsmErrorMessage(code) };
    }
    return { ok: true, code, message: null };
  }

  /** İYS's own auth object layered into the JSON body on top of Basic Auth —
   *  never logged (carries the plaintext password). */
  private header(creds: IysCreds): { username: string; password: string; brandCode: string } {
    return { username: creds.usercode, password: creds.password, brandCode: creds.brandCode };
  }

  /** NetgsmRestClient's Basic-Auth creds shape — brandCode is İYS-only, dropped here. */
  private basicCreds(creds: IysCreds): { usercode: string; password: string } {
    return { usercode: creds.usercode, password: creds.password };
  }

  /** NetGSM answers either a JSON envelope `{code, ...}` or a bare numeric status
   *  line — same tolerant extraction as SmsV2Client/BalanceClient. */
  private extractCode(body: any, rawText: string): string | null {
    if (body?.code != null) return String(body.code);
    if (/^\d{2,3}$/.test(rawText)) return rawText;
    return null;
  }

  /** `/iys/add`'s per-row result array casing isn't pinned down (docs revisions
   *  disagree) — tolerate iysRecipients/iys_recipients/recipients/refids, and
   *  each row's refid/refId/RefId/referenceId/refID key. */
  private extractRefids(body: any): string[] {
    const rows: any[] =
      Array.isArray(body?.iysRecipients) ? body.iysRecipients
      : Array.isArray(body?.iys_recipients) ? body.iys_recipients
      : Array.isArray(body?.recipients) ? body.recipients
      : Array.isArray(body?.refids) ? body.refids
      : [];
    return rows
      .map((r) => (typeof r === 'string' ? r : r?.refid ?? r?.refId ?? r?.RefId ?? r?.referenceId ?? r?.refID))
      .filter((r) => r != null)
      .map((r) => String(r));
  }

  /** `/iys/search`'s status field casing tolerated the same way; an unrecognized
   *  value is surfaced as `null` rather than guessed at. */
  private extractConsentStatus(body: any): 'ONAY' | 'RET' | 'YOK' | null {
    const raw = body?.status ?? body?.durum ?? body?.sonuc;
    const upper = raw != null ? String(raw).toUpperCase() : '';
    return CONSENT_STATUSES.has(upper) ? (upper as 'ONAY' | 'RET' | 'YOK') : null;
  }
}
