/**
 * Commerce ingest kill switches (contract §9). Same rule as
 * `growth-autonomy.flag.ts`: only `1 | true | on` arms them, so both ship dark.
 *
 * - `COMMERCE_INGEST_ENABLED` — the public order webhook. Off → 404, as if the
 *   route did not exist. Source management still works while it is off, so a
 *   workspace can be set up before the endpoint is opened.
 * - `COMMERCE_REVENUE_IN_ROAS` — whether paid store orders feed the
 *   performance loop. That loop OVERWRITES `AdMetric.revenue/roas`, which the
 *   Growth Autopilot reads, so it has its own flag and the owner decides it.
 */
function armed(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function commerceIngestEnabled(): boolean {
  return armed('COMMERCE_INGEST_ENABLED');
}

export function commerceRevenueEnabled(): boolean {
  return armed('COMMERCE_REVENUE_IN_ROAS');
}
