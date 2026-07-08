import { Injectable, Logger } from '@nestjs/common';
import { NetgsmRestClient } from '../core/netgsm-rest.client';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

export interface SmsV2SendResult {
  ok: boolean;
  code: string;
  jobid: string | null;
  message: string | null;
  retriable: boolean;
}

export interface SmsV2ReportRow {
  jobid: string;
  telno: string;
  status: number;
  deliveredDate: string | null;
  errorCode: string | null;
  referansId: string | null;
}

export interface SmsV2ReportResult {
  ok: boolean;
  code: string;
  rows: SmsV2ReportRow[];
}

export interface SmsV2SendMessage {
  msg: string;
  no: string;
  /** Caller-supplied correlation id, carried onto the wire and echoed back on report rows. */
  referansId?: string;
}

export interface SmsV2SendRequest {
  msgheader: string;
  /** True n:n bulk — each entry can carry its own text/recipient/referansId. */
  messages: SmsV2SendMessage[];
  encoding?: 'TR';
  iysfilter?: '0' | '11' | '12';
  /** ddMMyyyyHHmm, TR local time. */
  startdate?: string;
  /** ddMMyyyyHHmm, TR local time. */
  stopdate?: string;
}

export interface SmsV2OtpRequest {
  msgheader: string;
  msg: string;
  no: string;
}

export interface SmsV2MsgheadersResult {
  ok: boolean;
  headers: string[];
}

export interface SmsV2CancelResult {
  ok: boolean;
  code: string;
  message: string | null;
}

export interface SmsV2InboxMessage {
  msg: string;
  no: string;
  date: string | null;
  id: string | null;
}

export interface SmsV2InboxResult {
  ok: boolean;
  messages: SmsV2InboxMessage[];
}

type NetgsmCreds = { usercode: string; password: string };

/** Only transient throttling (80) eases on its own; every other code needs a fix — mirrors interpretNetgsmSend. */
const RETRIABLE_CODES = new Set(['80']);

const TURKISH_CHARS_RE = /[çÇğĞıİöÖşŞüÜ]/;
/** NetGSM OTP is documented as single-segment only: 155 GSM-7 chars, no concatenation. */
const OTP_MAX_SEGMENT_CHARS = 155;

/**
 * NetGSM SMS REST v2 hub client (send n:n / report / otp / msgheader / cancel /
 * inbox). Transport, Basic Auth and credential scrubbing are owned entirely by
 * `NetgsmRestClient` — this class only shapes request/response bodies and
 * classifies outcomes. Parsing is tolerant throughout (NetGSM's REST v2
 * responses vary in casing across accounts/docs revisions and sometimes answer
 * a bare legacy status code instead of JSON), mirroring `BalanceClient`.
 * Retriable is `true` ONLY for code '80' (rate limit) — every other error
 * needs a fix, not a retry (mirrors `interpretNetgsmSend`).
 */
@Injectable()
export class SmsV2Client {
  private readonly logger = new Logger(SmsV2Client.name);

  constructor(private readonly rest: NetgsmRestClient) {}

  /** True n:n bulk send. Each message may carry its own referansId, mapped onto the
   *  wire as `referansID` (the documented REST v2 casing) and echoed back on report rows. */
  async send(creds: NetgsmCreds, req: SmsV2SendRequest): Promise<SmsV2SendResult> {
    const body: Record<string, unknown> = {
      msgheader: req.msgheader,
      messages: req.messages.map((m) => {
        const wire: Record<string, unknown> = { msg: m.msg, no: m.no };
        if (m.referansId != null) wire.referansID = m.referansId;
        return wire;
      }),
    };
    if (req.encoding !== undefined) body.encoding = req.encoding;
    if (req.iysfilter !== undefined) body.iysfilter = req.iysfilter;
    if (req.startdate !== undefined) body.startdate = req.startdate;
    if (req.stopdate !== undefined) body.stopdate = req.stopdate;
    return this.doSend('/sms/rest/v2/send', creds, body);
  }

  /** OTP is a paid, single-recipient, single-segment, domestic-mobile-only channel — every
   *  constraint NetGSM would otherwise reject at the API is enforced here first so a bad
   *  request never burns a rate-limited call or a billed send. */
  async otp(creds: NetgsmCreds, req: SmsV2OtpRequest): Promise<SmsV2SendResult> {
    const validationError = this.validateOtp(req.msg, req.no);
    if (validationError) {
      return { ok: false, code: '', jobid: null, message: validationError, retriable: false };
    }
    const normalizedNo = this.normalizeDomesticMobile(req.no) as string;
    return this.doSend('/sms/rest/v2/otp', creds, {
      msgheader: req.msgheader,
      msg: req.msg,
      no: normalizedNo,
    });
  }

  private async doSend(path: string, creds: NetgsmCreds, body: unknown): Promise<SmsV2SendResult> {
    let httpStatus: number, respBody: any, rawText: string;
    try {
      ({ httpStatus, body: respBody, rawText } = await this.rest.request({ path, method: 'POST', creds, body }));
    } catch (e: any) {
      // Transport-level failure (timeout/DNS). Message is already cred-scrubbed
      // by NetgsmRestClient; safe to log for send-path visibility.
      this.logger.warn(`netgsm v2 ${path} transport error: ${e?.message ?? e}`);
      return { ok: false, code: '', jobid: null, message: e?.message ?? 'NetGSM erişilemedi', retriable: false };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null) {
      return {
        ok: false, code: '', jobid: null,
        message: `NetGSM beklenmedik yanıt döndürdü (HTTP ${httpStatus}).`,
        retriable: false,
      };
    }
    if (code !== '00') {
      // Unify on netgsmErrorMessage rather than echoing respBody.description: the
      // description text varies by endpoint/account and isn't guaranteed Turkish,
      // whereas every other NetGSM surface in this app explains a code the same way.
      return {
        ok: false, code, jobid: null,
        message: netgsmErrorMessage(code),
        retriable: RETRIABLE_CODES.has(code),
      };
    }
    return { ok: true, code, jobid: respBody?.jobid != null ? String(respBody.jobid) : null, message: null, retriable: false };
  }

  /** Caller chunks jobids to ≤50 per NetGSM's documented per-call limit. */
  async report(creds: NetgsmCreds, jobids: string[]): Promise<SmsV2ReportResult> {
    let httpStatus: number, respBody: any, rawText: string;
    try {
      ({ httpStatus, body: respBody, rawText } = await this.rest.request({
        path: '/sms/rest/v2/report', method: 'POST', creds, body: { jobids },
      }));
    } catch {
      return { ok: false, code: '', rows: [] };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null || code !== '00') {
      return { ok: false, code: code ?? String(httpStatus), rows: [] };
    }
    const jobs: any[] = Array.isArray(respBody?.jobs) ? respBody.jobs : [];
    const rows: SmsV2ReportRow[] = jobs.map((j) => ({
      jobid: String(j?.jobid ?? ''),
      telno: String(j?.telno ?? ''),
      status: Number(j?.status),
      deliveredDate: j?.deliveredDate != null ? String(j.deliveredDate) : null,
      errorCode: j?.errorCode != null ? String(j.errorCode) : null,
      // Tolerate every documented casing variant on the way in.
      referansId:
        j?.referansID != null ? String(j.referansID)
        : j?.referansId != null ? String(j.referansId)
        : j?.referans != null ? String(j.referans)
        : null,
    }));
    return { ok: true, code, rows };
  }

  async msgheaders(creds: NetgsmCreds): Promise<SmsV2MsgheadersResult> {
    let respBody: any, rawText: string;
    try {
      ({ body: respBody, rawText } = await this.rest.request({ path: '/sms/rest/v2/msgheader', method: 'GET', creds }));
    } catch {
      return { ok: false, headers: [] };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null || code !== '00') return { ok: false, headers: [] };
    const headers: string[] = Array.isArray(respBody?.msgheaders) ? respBody.msgheaders.map((h: unknown) => String(h)) : [];
    return { ok: true, headers };
  }

  /** Future-dated jobs only; NetGSM answers 60 for not-found / not-cancellable. */
  async cancel(creds: NetgsmCreds, jobid: string): Promise<SmsV2CancelResult> {
    let httpStatus: number, respBody: any, rawText: string;
    try {
      ({ httpStatus, body: respBody, rawText } = await this.rest.request({
        path: '/sms/rest/v2/cancel', method: 'POST', creds, body: { jobid },
      }));
    } catch (e: any) {
      return { ok: false, code: '', message: e?.message ?? 'NetGSM erişilemedi' };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null) {
      return { ok: false, code: '', message: `NetGSM beklenmedik yanıt döndürdü (HTTP ${httpStatus}).` };
    }
    if (code !== '00') return { ok: false, code, message: netgsmErrorMessage(code) };
    return { ok: true, code, message: null };
  }

  /**
   * Date-ranged MO poll ONLY — startdate/stopdate are required params, never
   * optional, because NetGSM's parameterless inbox form marks every message
   * seen as a side effect and would race the push webhook (Phase 0 finding).
   * Window format ddMMyyyyHHmm, TR local time, ≤30 days.
   */
  async inbox(creds: NetgsmCreds, startdate: string, stopdate: string): Promise<SmsV2InboxResult> {
    const qs = new URLSearchParams({ startdate, stopdate }).toString();
    let respBody: any, rawText: string;
    try {
      ({ body: respBody, rawText } = await this.rest.request({
        path: `/sms/rest/v2/inbox?${qs}`, method: 'GET', creds,
      }));
    } catch {
      return { ok: false, messages: [] };
    }
    const code = this.extractCode(respBody, rawText);
    if (code == null || code !== '00') return { ok: false, messages: [] };
    const rows: any[] = Array.isArray(respBody?.messages) ? respBody.messages : [];
    const messages: SmsV2InboxMessage[] = rows.map((r) => ({
      msg: String(r?.msg ?? r?.message ?? ''),
      no: String(r?.no ?? r?.gsmno ?? ''),
      date: r?.date != null ? String(r.date) : null,
      id: r?.id != null ? String(r.id) : null,
    }));
    return { ok: true, messages };
  }

  /** NetGSM answers either a JSON envelope `{code, ...}` or (legacy-flavoured
   *  endpoints) a bare numeric status line — same tolerant extraction as BalanceClient. */
  private extractCode(body: any, rawText: string): string | null {
    if (body?.code != null) return String(body.code);
    if (/^\d{2,3}$/.test(rawText)) return rawText;
    return null;
  }

  private validateOtp(msg: string, no: string): string | null {
    if (msg.length > OTP_MAX_SEGMENT_CHARS) {
      return `OTP mesajı tek SMS segmentini aşamaz (en fazla ${OTP_MAX_SEGMENT_CHARS} karakter).`;
    }
    if (TURKISH_CHARS_RE.test(msg)) {
      return "OTP mesajı Türkçe karakter içeremez (çÇğĞıİöÖşŞüÜ).";
    }
    if (this.normalizeDomesticMobile(no) == null) {
      return 'OTP yalnızca yurt içi (05xxxxxxxxx) cep telefonu numaralarına gönderilebilir.';
    }
    return null;
  }

  /** Normalizes +90/90/0/bare forms of a Turkish mobile to 05xxxxxxxxx; null if it
   *  isn't a 10-digit domestic mobile (landline area codes, foreign numbers, etc). */
  private normalizeDomesticMobile(raw: string): string | null {
    let d = (raw ?? '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length !== 10 || !d.startsWith('5')) return null;
    return `0${d}`;
  }
}
