import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { netgsmErrorMessage } from '../core/netgsm-error.map';
import { AccountRateBudgeter } from '../core/account-rate-budgeter';

type NetgsmCreds = { usercode: string; password: string };

/** Only `queue` is wired today — the parallel dialer routes a live list at a
 *  Netsantral queue with logged-in agents; NetGSM's docs also mention other
 *  destination types (dahili/announcement) that aren't exercised here. */
export type AutocallDestinationType = 'queue';

/** Per-day calling window. NetGSM's own field names/vocabulary for `day`
 *  aren't pinned down by research — passed through as-is (best-effort:
 *  'MONDAY'..'SUNDAY' or a 1-7 index); `start`/`end` are 'HH:mm' local time. */
export interface AutocallTimeWindow {
  day?: string;
  start: string;
  end: string;
}

export interface AddAutocallRequest {
  listName: string;
  destinationType: AutocallDestinationType;
  /** The pre-existing, agent-staffed Netsantral queue this list dials into
   *  (operator-configured in the NetGSM panel — never created by this app). */
  queueName: string;
  /** MANDATORY — `addAutocall` refuses to call NetGSM at all without one (see
   *  `hasIysfilter`). '0' = BİLGİLENDİRME, '11'/'12' = TİCARİ variants. */
  iysfilter: '0' | '11' | '12';
  /** Required alongside a TİCARİ iysfilter ('11'/'12'). */
  brandcode?: string;
  /** How many times to re-attempt an unanswered number. */
  retryCount?: number;
  timeWindows?: AutocallTimeWindow[];
  /** Our per-attempt webhook URL (`netgsmWebhookUrl(base, workspaceId, 'autocall-report')`). */
  url?: string;
}

export interface AddAutocallResult {
  ok: boolean;
  code: string;
  /** NetGSM's own list/job identifier for this dynamic list — pass to every
   *  subsequent addNumber/deleteNumber/updateListStatus/reportAutocall call.
   *  Best-effort inference: the per-attempt webhook's `JobID` is assumed to be
   *  the SAME identifier (NOT live-verified — see class docstring). */
  jobId: string | null;
  /** Alias of `jobId` — kept as a separate field because NetGSM's own docs use
   *  "list" and "job" near-interchangeably for this surface; both name the
   *  same value here. */
  listId: string | null;
  message: string | null;
  /** True only for a rate-limit/budget denial — safe to retry shortly. */
  retriable: boolean;
}

export interface AutocallActionResult {
  ok: boolean;
  code: string | null;
  message: string | null;
  retriable: boolean;
}

/** One row of `reportautocall`'s reconciliation dump. Field names beyond
 *  `called`/`uniqueId`/`status` aren't researched — tolerated via the index
 *  signature so a real account's extra columns don't get silently dropped. */
export interface ReportAutocallRow {
  called: string | null;
  uniqueId: string | null;
  status: string | null;
  [key: string]: unknown;
}

export interface ReportAutocallResult {
  ok: boolean;
  rows: ReportAutocallRow[];
  message: string | null;
  retriable: boolean;
}

/** The account-wide `/autocallservice` rate cap (facts: 10 req/min), shared by
 *  every method on this client — mirrors İYS's aggregate-not-per-endpoint cap
 *  (`IysClient`'s callers all share the `'iys'` bucket). */
const AUTOCALL_BUDGET_LIMIT = 10;
const AUTOCALL_BUDGET_WINDOW_MS = 60_000;

/** Only transient throttling (80) eases on its own — mirrors every other
 *  classic-API client's RETRIABLE_CODES set. */
const RETRIABLE_CODES = new Set(['80']);

const VALID_IYSFILTERS = new Set(['0', '11', '12']);

/** True only for a recognized iysfilter value — the guard `addAutocall` uses
 *  to refuse creating a list without one. Exported for the spec + reuse by a
 *  future caller that wants to validate before ever calling this client. */
export function hasIysfilter(v: unknown): v is '0' | '11' | '12' {
  return typeof v === 'string' && VALID_IYSFILTERS.has(v);
}

/**
 * NetGSM auto-dialer ("Otomatik Arama" / parallel power-dialer) hub client —
 * `/autocallservice/{addautocall,addnumber,deletenumber,updateliststatus,
 * reportautocall}`. A "Devamlı Dinamik" (continuous/dynamic) list: created
 * once via `addAutocall`, numbers streamed in/out live via `addNumber`/
 * `deleteNumber` while it runs, started/stopped via `updateListStatus`, and
 * reconciled via `reportAutocall`. Same host + JSON-body-creds transport as
 * `VoicesmsSendClient`/`NetgsmCdrClient` (usercode/password IN the body, not
 * the REST v2 Basic-Auth `NetgsmRestClient` uses), same tolerant multi-alias
 * parsing philosophy, same `{code, error}` envelope. Never logs credentials.
 *
 * REQUIRES the paid "Otomatik Arama" add-on + a Netsantral queue with
 * logged-in agents (facts) — without either, NetGSM answers with its generic
 * no-package error (code 60, see `netgsm-error.map.ts`); this client surfaces
 * that as an ordinary `ok:false` result rather than a special case, so the
 * caller's existing error-message plumbing already explains it.
 *
 * `iysfilter` is MANDATORY on `addAutocall` — enforced by `hasIysfilter`
 * BEFORE any network call, so a list can never be created without proving a
 * consent classification (mirrors `VoicesmsSendClient.send`'s msg-or-audioid
 * pre-flight guard).
 *
 * Rate limit: 10 req/min per account, shared across EVERY method here (facts)
 * — every call spends one `AccountRateBudgeter('autocall')` slot BEFORE
 * hitting the network; a denial returns `retriable: true` rather than ever
 * reaching NetGSM, so a tight streaming loop (e.g. `addNumber` called once per
 * lead) degrades to "come back next tick" instead of tripping NetGSM's own
 * limit.
 *
 * Endpoint paths, request field names, and the response's `jobid`/`listid`
 * casing are researched from NetGSM's documented autocall contract, NOT yet
 * live-verified against a real account (the SAME "researched, not yet
 * live-verified" status this whole program's voice/autocall surfaces carry
 * until Phase 5 goes live) — parsing stays tolerant of aliases so a real
 * account's actual field names slot in without a rewrite.
 */
@Injectable()
export class AutocallClient {
  private readonly logger = new Logger(AutocallClient.name);
  static readonly ADD_URL = 'https://api.netgsm.com.tr/autocallservice/addautocall';
  static readonly ADD_NUMBER_URL = 'https://api.netgsm.com.tr/autocallservice/addnumber';
  static readonly DELETE_NUMBER_URL = 'https://api.netgsm.com.tr/autocallservice/deletenumber';
  static readonly UPDATE_STATUS_URL = 'https://api.netgsm.com.tr/autocallservice/updateliststatus';
  static readonly REPORT_URL = 'https://api.netgsm.com.tr/autocallservice/reportautocall';

  constructor(private readonly budgeter: AccountRateBudgeter) {}

  /** Create the dynamic autocall list. Refuses (never touches the network)
   *  when `iysfilter` is missing/unrecognized — a list can't be created
   *  without a consent classification. */
  async addAutocall(creds: NetgsmCreds, req: AddAutocallRequest): Promise<AddAutocallResult> {
    if (!hasIysfilter(req.iysfilter)) {
      return {
        ok: false, code: '', jobId: null, listId: null,
        message: 'Otomatik arama listesi iysfilter (İYS sınıflandırması) olmadan oluşturulamaz.',
        retriable: false,
      };
    }
    if (!this.takeBudget(creds.usercode)) {
      return { ...this.budgetDenied(), jobId: null, listId: null };
    }
    const body: Record<string, unknown> = {
      usercode: creds.usercode,
      password: creds.password,
      list_name: req.listName,
      destination_type: req.destinationType,
      queue_name: req.queueName,
      iysfilter: req.iysfilter,
      list_type: 'DYNAMIC', // "Devamlı Dinamik" per the facts
    };
    if (req.brandcode !== undefined) body.brandcode = req.brandcode;
    if (req.retryCount !== undefined) body.retry_count = req.retryCount;
    if (req.timeWindows !== undefined) body.time_windows = req.timeWindows;
    if (req.url !== undefined) body.url = req.url;

    let respBody: any;
    try {
      const res = await safeFetch(AutocallClient.ADD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm autocall addautocall transport error: ${this.scrub(e, creds)}`);
      return {
        ok: false, code: '', jobId: null, listId: null,
        message: 'NetGSM otomatik arama isteğine ulaşılamadı.', retriable: false,
      };
    }
    if (!respBody) {
      return { ok: false, code: '', jobId: null, listId: null, message: 'NetGSM boş yanıt döndürdü.', retriable: false };
    }
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code == null) {
      return {
        ok: false, code: '', jobId: null, listId: null,
        message: 'NetGSM beklenmedik yanıt döndürdü.', retriable: false,
      };
    }
    if (code !== '00') {
      const message = this.errorMessage(respBody, code);
      this.logger.warn(`netgsm autocall addautocall error code=${code} ${message}`);
      return { ok: false, code, jobId: null, listId: null, message, retriable: RETRIABLE_CODES.has(code) };
    }
    const id = pick(respBody, ['jobid', 'jobId', 'JobID', 'listid', 'listId', 'ListID', 'id']);
    const idStr = id != null ? String(id) : null;
    return { ok: true, code, jobId: idStr, listId: idStr, message: null, retriable: false };
  }

  /** Add one number to a running list. */
  async addNumber(creds: NetgsmCreds, listId: string, no: string): Promise<AutocallActionResult> {
    return this.numberAction(AutocallClient.ADD_NUMBER_URL, 'addnumber', creds, listId, no);
  }

  /** Remove one number from a running list (e.g. a lead opted out mid-stream). */
  async deleteNumber(creds: NetgsmCreds, listId: string, no: string): Promise<AutocallActionResult> {
    return this.numberAction(AutocallClient.DELETE_NUMBER_URL, 'deletenumber', creds, listId, no);
  }

  private async numberAction(
    url: string,
    label: string,
    creds: NetgsmCreds,
    listId: string,
    no: string,
  ): Promise<AutocallActionResult> {
    if (!this.takeBudget(creds.usercode)) return this.budgetDenied();
    const body = { usercode: creds.usercode, password: creds.password, list_id: listId, no };
    let respBody: any;
    try {
      const res = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm autocall ${label} transport error: ${this.scrub(e, creds)}`);
      return { ok: false, code: null, message: `NetGSM otomatik arama ${label} isteğine ulaşılamadı.`, retriable: false };
    }
    if (!respBody) return { ok: false, code: null, message: 'NetGSM boş yanıt döndürdü.', retriable: false };
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code && code !== '00') {
      const message = this.errorMessage(respBody, code);
      this.logger.warn(`netgsm autocall ${label} error code=${code} ${message}`);
      return { ok: false, code, message, retriable: RETRIABLE_CODES.has(code) };
    }
    return { ok: true, code: code ?? '00', message: null, retriable: false };
  }

  /** Start or stop the whole list (agents begin/stop being offered its numbers). */
  async updateListStatus(creds: NetgsmCreds, listId: string, action: 'start' | 'stop'): Promise<AutocallActionResult> {
    if (!this.takeBudget(creds.usercode)) return this.budgetDenied();
    const body = { usercode: creds.usercode, password: creds.password, list_id: listId, status: action };
    let respBody: any;
    try {
      const res = await safeFetch(AutocallClient.UPDATE_STATUS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm autocall updateliststatus transport error: ${this.scrub(e, creds)}`);
      return { ok: false, code: null, message: 'NetGSM otomatik arama durum güncelleme isteğine ulaşılamadı.', retriable: false };
    }
    if (!respBody) return { ok: false, code: null, message: 'NetGSM boş yanıt döndürdü.', retriable: false };
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code && code !== '00') {
      const message = this.errorMessage(respBody, code);
      this.logger.warn(`netgsm autocall updateliststatus error code=${code} ${message}`);
      return { ok: false, code, message, retriable: RETRIABLE_CODES.has(code) };
    }
    return { ok: true, code: code ?? '00', message: null, retriable: false };
  }

  /** Reconciliation dump for a list — per-number outcomes as NetGSM currently
   *  sees them (a backstop for the attempt webhook, mirrors how
   *  `netgsm-dlr-poll.service.ts` polls as the SMS DLR backstop). */
  async reportAutocall(creds: NetgsmCreds, listId: string): Promise<ReportAutocallResult> {
    if (!this.takeBudget(creds.usercode)) return { ok: false, rows: [], message: this.budgetDenied().message, retriable: true };
    let respBody: any;
    try {
      const res = await safeFetch(AutocallClient.REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usercode: creds.usercode, password: creds.password, list_id: listId }),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm autocall reportautocall transport error: ${this.scrub(e, creds)}`);
      return { ok: false, rows: [], message: 'NetGSM otomatik arama raporu isteğine ulaşılamadı.', retriable: false };
    }
    if (!respBody) return { ok: false, rows: [], message: 'NetGSM boş yanıt döndürdü.', retriable: false };
    if (!Array.isArray(respBody) && typeof respBody === 'object' && respBody.code && !Array.isArray(respBody.values) && !Array.isArray(respBody.data)) {
      const code = String(respBody.code);
      const message = this.errorMessage(respBody, code);
      this.logger.warn(`netgsm autocall reportautocall error code=${code} ${message}`);
      return { ok: false, rows: [], message, retriable: RETRIABLE_CODES.has(code) };
    }
    return { ok: true, rows: normalizeReportRows(respBody), message: null, retriable: false };
  }

  private takeBudget(usercode: string): boolean {
    return this.budgeter.tryTake(usercode, 'autocall', AUTOCALL_BUDGET_LIMIT, AUTOCALL_BUDGET_WINDOW_MS);
  }

  private budgetDenied(): AutocallActionResult {
    return {
      ok: false, code: null,
      message: "NetGSM otomatik arama hız limiti (dakikada 10 istek) doldu — kısa bir süre sonra yeniden deneyin.",
      retriable: true,
    };
  }

  private errorMessage(body: any, code: string): string {
    return typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : netgsmErrorMessage(code);
  }

  /** Scrub both cred values out of a thrown transport error's message before
   *  it's ever logged — a timeout/DNS error can echo the POST body verbatim. */
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

function normalizeReportRows(body: any): ReportAutocallRow[] {
  let items: any[] = [];
  if (Array.isArray(body)) items = body;
  else if (Array.isArray(body?.data)) items = body.data;
  else if (Array.isArray(body?.values)) items = body.values;
  else if (body && typeof body === 'object') items = Object.values(body).filter((v) => v && typeof v === 'object');
  return items.map((raw) => {
    const o = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : raw;
    return {
      called: pick(o, ['called', 'no', 'number', 'aranan']) ?? null,
      uniqueId: pick(o, ['unique_id', 'uniqueid', 'uniqueId']) ?? null,
      status: pick(o, ['status', 'durum']) ?? null,
      ...o,
    } as ReportAutocallRow;
  });
}
