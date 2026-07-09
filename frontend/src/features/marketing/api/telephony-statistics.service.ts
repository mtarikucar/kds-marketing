/**
 * telephony-statistics.service.ts — typed API call for the inbound call
 * statistics dashboard (NetGSM Phase 4 Task 5). 503s server-side until the
 * workspace has an ACTIVE Netsantral config (same as the queue wallboard);
 * once configured, `/netsantral/statistics` itself only authenticates from
 * NetGSM's allow-listed production IP, so off-prod the response still comes
 * back 200 with `ok:false` + a NetGSM `code` — the panel renders that as an
 * informational note rather than an error state.
 */

import marketingApi from './marketingApi';

export interface TelephonyDailyStat {
  date?: string;
  answered: number;
  abandoned: number;
  avgWaitSec: number | null;
}

export interface TelephonyStatisticsSummary {
  answered: number;
  abandoned: number;
  avgWaitSec: number | null;
}

export interface TelephonyStatisticsResponse {
  from: string;
  to: string;
  clamped: boolean;
  /** False when NetGSM rejected the request (e.g. off-prod IP not allow-listed). */
  ok: boolean;
  code?: string;
  daily: TelephonyDailyStat[];
  summary: TelephonyStatisticsSummary;
}

/** GET /marketing/telephony/statistics?from&to (both optional — the backend defaults to the trailing 7 days). */
export const getTelephonyStatistics = (from?: string, to?: string): Promise<TelephonyStatisticsResponse> =>
  marketingApi
    .get('/telephony/statistics', { params: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })
    .then((r) => r.data as TelephonyStatisticsResponse);
