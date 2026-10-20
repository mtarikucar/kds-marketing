import { Injectable } from '@nestjs/common';
import { Ga4HttpClient } from './ga4-http.client';
import { GA4_PROPERTY_ID } from './ga4-oauth.service';

export type Ga4Dimension = 'TOTAL' | 'SOURCE_MEDIUM' | 'CAMPAIGN';

/** One day × key of a report, metrics already numbers. */
export interface Ga4Row {
  date: string; // YYYY-MM-DD, the property's own calendar day
  key: string; // '' for TOTAL
  sessions: number;
  totalUsers: number;
  newUsers: number;
  conversions: number;
  purchaseCount: number;
  purchaseValue: number;
}

/** A Data API refusal, with the HTTP status the sync decides on (401 = re-auth path). */
export class Ga4ApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`GA4 Data API ${status}${detail ? `: ${detail}` : ''}`);
  }
}

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
/** Per day and breakdown; the rest is summed into "(other)" (contract §6.2). */
export const TOP_KEYS_PER_DAY = 50;
const OTHER = '(other)';

const BREAKDOWN: Record<Ga4Dimension, string | null> = {
  TOTAL: null,
  SOURCE_MEDIUM: 'sessionSourceMedium',
  CAMPAIGN: 'sessionCampaignName',
};

/** GA4 metric → our column. `keyEvents` is what GA4 now calls conversions. */
const METRICS: Array<[string, keyof Omit<Ga4Row, 'date' | 'key'>]> = [
  ['sessions', 'sessions'],
  ['totalUsers', 'totalUsers'],
  ['newUsers', 'newUsers'],
  ['keyEvents', 'conversions'],
  ['ecommercePurchases', 'purchaseCount'],
  ['purchaseRevenue', 'purchaseValue'],
];

/**
 * GA4 Data API `runReport` (contract §6.3): one request per breakdown, daily
 * rows over a relative window (`3daysAgo`…`yesterday`), which GA4 resolves in
 * the property's own time zone. Metrics are read by header NAME, never by
 * position.
 */
@Injectable()
export class Ga4DataClient {
  constructor(private readonly http: Ga4HttpClient) {}

  async runReport(
    accessToken: string,
    propertyId: string,
    opts: { startDate: string; endDate: string; dimension: Ga4Dimension },
  ): Promise<{ currency: string | null; rows: Ga4Row[] }> {
    if (!GA4_PROPERTY_ID.test(propertyId)) throw new Error(`invalid GA4 property id: ${propertyId.slice(0, 40)}`);
    const breakdown = BREAKDOWN[opts.dimension];
    const res = await this.http.fetch(`${DATA_API}/${propertyId}:runReport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: opts.startDate, endDate: opts.endDate }],
        dimensions: [{ name: 'date' }, ...(breakdown ? [{ name: breakdown }] : [])],
        metrics: METRICS.map(([name]) => ({ name })),
        limit: '100000',
        keepEmptyRows: false,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Ga4ApiError(res.status, String(body?.error?.status ?? body?.error?.message ?? '').slice(0, 200));

    const dimIdx = (name: string) => (body.dimensionHeaders ?? []).findIndex((h: { name: string }) => h.name === name);
    const metIdx = METRICS.map(([name]) => (body.metricHeaders ?? []).findIndex((h: { name: string }) => h.name === name));
    const dateAt = dimIdx('date');
    const keyAt = breakdown ? dimIdx(breakdown) : -1;

    const rows: Ga4Row[] = [];
    for (const r of body.rows ?? []) {
      const d = String(r.dimensionValues?.[dateAt]?.value ?? '');
      if (!/^\d{8}$/.test(d)) continue;
      const row = {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        key: keyAt >= 0 ? String(r.dimensionValues?.[keyAt]?.value ?? '').slice(0, 200) : '',
      } as Ga4Row;
      METRICS.forEach(([, col], i) => {
        const n = Number(r.metricValues?.[metIdx[i]]?.value ?? 0);
        row[col] = Number.isFinite(n) ? n : 0;
      });
      rows.push(row);
    }
    return {
      currency: typeof body.metadata?.currencyCode === 'string' ? body.metadata.currencyCode : null,
      rows: breakdown ? foldTopN(rows, TOP_KEYS_PER_DAY) : rows,
    };
  }
}

/**
 * At most `n` keys per day, by sessions; everything else — including a GA4
 * "(other)" row of its own — summed into one "(other)" row for that day.
 */
export function foldTopN(rows: Ga4Row[], n: number): Ga4Row[] {
  const byDate = new Map<string, Ga4Row[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const out: Ga4Row[] = [];
  for (const [date, dayRows] of byDate) {
    const ranked = dayRows.filter((r) => r.key !== OTHER).sort((a, b) => b.sessions - a.sessions);
    out.push(...ranked.slice(0, n));
    const rest = [...ranked.slice(n), ...dayRows.filter((r) => r.key === OTHER)];
    if (rest.length) {
      const other: Ga4Row = { date, key: OTHER, sessions: 0, totalUsers: 0, newUsers: 0, conversions: 0, purchaseCount: 0, purchaseValue: 0 };
      for (const r of rest) {
        other.sessions += r.sessions;
        other.totalUsers += r.totalUsers;
        other.newUsers += r.newUsers;
        other.conversions += r.conversions;
        other.purchaseCount += r.purchaseCount;
        other.purchaseValue = Math.round((other.purchaseValue + r.purchaseValue) * 100) / 100;
      }
      out.push(other);
    }
  }
  return out;
}
