/**
 * GA4 kill switch (contract §9). Same rule as `growth-autonomy.flag.ts`: only
 * `1 | true | on` arms it, so the feature ships dark. Off: every GA4 route
 * answers 404 and the hourly sync does nothing.
 */
export function ga4SyncEnabled(): boolean {
  const v = (process.env.GA4_SYNC_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
