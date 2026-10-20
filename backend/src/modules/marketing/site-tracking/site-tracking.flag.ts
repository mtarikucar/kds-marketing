/**
 * Site snippet kill switch (contract §9): only `1 | true | on` arms it. Off:
 * the pixel still answers 200 with a GIF (a store page must never break) but
 * counts nothing, and key management answers 404.
 */
export function siteTrackingEnabled(): boolean {
  const v = (process.env.SITE_TRACKING_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
