import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';

/** Mode 1 (daily aggregate) row from `/netsantral/statistics`. */
export interface StatisticsDailyAggregate {
  date?: string;
  answered: number;
  abandoned: number;
  /** Average wait time in seconds, or null when NetGSM didn't report one. */
  avgWaitSec: number | null;
  /** Total calls for the day, when the provider reports it separately from answered+abandoned. */
  totalCalls?: number;
}

/** Mode 2 (per-call detail) row from `/netsantral/statistics` — includes the recording link. */
export interface StatisticsCallDetail {
  date?: string;
  source?: string;
  destination?: string;
  duration: number; // seconds
  /** Time the caller waited before being answered/abandoning, in seconds. */
  waitSec: number | null;
  /** Provider's own answered/abandoned marker, kept verbatim (casing/wording unconfirmed). */
  status?: string;
  recording?: string;
}

export interface StatisticsFetchParams {
  mode: 1 | 2;
  /** ddMMyyyyHHmm, Turkey local time. */
  startdate: string;
  /** ddMMyyyyHHmm, Turkey local time. */
  stopdate: string;
}

export interface StatisticsResult {
  ok: boolean;
  /** NetGSM's own error code (e.g. "30" pre-auth/IP-not-allow-listed), when present. */
  code?: string;
  message?: string;
  /** Populated (possibly empty) for mode 1; absent for mode 2. */
  daily?: StatisticsDailyAggregate[];
  /** Populated (possibly empty) for mode 2; absent for mode 1. */
  calls?: StatisticsCallDetail[];
}

/**
 * NetGSM Netsantral inbound-statistics client — `/netsantral/statistics` over
 * the standard NetGSM API (NetGSM Phase 4 Task 5).
 *
 * POST https://api.netgsm.com.tr/netsantral/statistics (JSON: usercode,
 * password, mode, startdate, stopdate in ddMMyyyyHHmm) →
 *  - mode 1: daily aggregates (answered/abandoned/avg-wait), window ≤ 7 days
 *    (the CALLER — TelephonyReportsService — is responsible for clamping;
 *    this client does not enforce it, mirroring how NetgsmCdrClient doesn't
 *    enforce its own window either).
 *  - mode 2: per-call detail rows, including the recording link (mirrors
 *    NetgsmCdrClient's CdrRecord shape).
 *
 * Same caveats as the sibling CDR endpoint (`netgsm-cdr.client.ts`): this is
 * IP-ALLOW-LISTED to the production server, so it only authenticates from
 * production — a local/staging call returns a pre-auth error envelope
 * (`{code, error}`, HTTP 200) regardless of credential validity. The exact
 * response field casing is provider-defined and unconfirmed; `normalizeDaily`/
 * `normalizeCalls` read several known aliases defensively, and `fetchRaw`
 * exposes the raw body for diagnosis. Rate-limited by NetGSM to 2 req/min per
 * account — the CALLER budgets that via `AccountRateBudgeter('statistics')`,
 * not this client (mirrors every other budgeted NetGSM surface).
 */
@Injectable()
export class NetgsmStatisticsClient {
  private readonly logger = new Logger(NetgsmStatisticsClient.name);
  static readonly URL = 'https://api.netgsm.com.tr/netsantral/statistics';

  /** Raw NetGSM response (for diagnosis — lets us see real fields once confirmed live). */
  async fetchRaw(
    creds: { usercode: string; password: string },
    params: StatisticsFetchParams,
  ): Promise<{ httpStatus: number; body: any }> {
    const res = await safeFetch(NetgsmStatisticsClient.URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usercode: creds.usercode,
        password: creds.password,
        mode: params.mode,
        startdate: params.startdate,
        stopdate: params.stopdate,
      }),
      timeoutMs: 20_000,
    });
    const body = await res.json().catch(() => null);
    return { httpStatus: res.status, body };
  }

  /** Normalized, tolerant, never-throws statistics fetch. Never logs creds. */
  async fetchStatistics(
    creds: { usercode: string; password: string },
    params: StatisticsFetchParams,
  ): Promise<StatisticsResult> {
    let body: any;
    try {
      ({ body } = await this.fetchRaw(creds, params));
    } catch (e: any) {
      this.logger.warn(`netgsm statistics fetch failed: ${e?.message ?? e}`);
      return empty(params.mode, 'Netsantral statistics request failed');
    }
    if (!body) return empty(params.mode, 'Netsantral returned an empty response');
    // Error envelope: { code: "30"|"331"|..., error: "..." } (no records) — same
    // shape as the CDR endpoint's pre-auth/off-prod rejection.
    if (isErrorEnvelope(body)) {
      const code = String(body.code);
      const message = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : undefined;
      this.logger.warn(`netgsm statistics error code=${code} ${message ?? ''}`);
      return { ...empty(params.mode), ok: false, code, message };
    }
    return params.mode === 2
      ? { ok: true, calls: normalizeCalls(body) }
      : { ok: true, daily: normalizeDaily(body) };
  }
}

function empty(mode: 1 | 2, message?: string): StatisticsResult {
  return mode === 2 ? { ok: false, calls: [], message } : { ok: false, daily: [], message };
}

function isErrorEnvelope(body: any): boolean {
  if (Array.isArray(body) || !body || typeof body !== 'object') return false;
  if (body.code == null) return false;
  return !Array.isArray(body.values) && !Array.isArray(body.data) && !Array.isArray(body.daily) && !Array.isArray(body.calls);
}

const pick = (o: any, keys: string[]): any => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};

/** `"90"` -> 90, `"1:30"`/`"01:30:00"` -> seconds, unreadable -> null (never throws). */
function parseSeconds(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const parts = [m[1], m[2], m[3]].filter((x) => x != null).map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }
  return null;
}

/** Coerce the (array | keyed-object | {data:[]}/{daily:[]}/{values:[]}) response into rows. */
function toItems(body: any, listKey: 'daily' | 'calls'): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.[listKey])) return body[listKey];
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.values)) return body.values;
  if (body && typeof body === 'object') return Object.values(body).filter((v) => v && typeof v === 'object');
  return [];
}

function normalizeDaily(body: any): StatisticsDailyAggregate[] {
  return toItems(body, 'daily')
    .map(toDailyAggregate)
    .filter((d) => d.date || d.answered > 0 || d.abandoned > 0 || d.totalCalls);
}

function toDailyAggregate(raw: any): StatisticsDailyAggregate {
  const o = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : raw;
  const answeredRaw = pick(o, ['answered', 'cevaplanan', 'answered_calls', 'answeredCalls', 'cevaplanan_arama']);
  const abandonedRaw = pick(o, ['abandoned', 'cevapsiz', 'missed', 'abandoned_calls', 'abandonedCalls', 'cevapsiz_arama']);
  const waitRaw = pick(o, ['avgWaitSec', 'avg_wait', 'avgwait', 'avgWait', 'ortalama_bekleme', 'ortalamaBekleme']);
  const totalRaw = pick(o, ['total', 'toplam', 'totalCalls', 'total_calls']);
  return {
    date: pick(o, ['date', 'tarih', 'day', 'gun']),
    answered: Number(answeredRaw ?? 0) || 0,
    abandoned: Number(abandonedRaw ?? 0) || 0,
    avgWaitSec: waitRaw != null ? parseSeconds(waitRaw) : null,
    ...(totalRaw != null ? { totalCalls: Number(totalRaw) || 0 } : {}),
  };
}

function normalizeCalls(body: any): StatisticsCallDetail[] {
  return toItems(body, 'calls')
    .map(toCallDetail)
    .filter((c) => c.destination || c.source);
}

function toCallDetail(raw: any): StatisticsCallDetail {
  const o = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : raw;
  const durRaw = pick(o, ['duration', 'billsec', 'sure', 'süre', 'talktime']);
  const waitRaw = pick(o, ['waitSec', 'wait', 'bekleme', 'bekleme_suresi', 'waittime']);
  return {
    date: pick(o, ['date', 'tarih', 'datetime', 'calldate', 'start']),
    source: pick(o, ['source', 'caller', 'src', 'arayan', 'from']),
    destination: pick(o, ['destination', 'called', 'callee', 'dest', 'aranan', 'to']),
    duration: Number(durRaw ?? 0) || 0,
    waitSec: waitRaw != null ? parseSeconds(waitRaw) : null,
    status: pick(o, ['status', 'durum', 'sonuc']),
    recording: pick(o, ['recording', 'kayit', 'kayıt', 'record', 'recordingurl', 'voice']),
  };
}
