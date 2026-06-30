/**
 * The TikTok DM webhook callback URL operators paste into the TikTok for
 * Business app dashboard. STATIC — one URL for the whole app; the trust
 * boundary is the HMAC-SHA256 signature over the raw body (see
 * TiktokWebhookController.validSignature). No per-channel token in the path
 * (unlike the unsigned NetGSM MO callback). Null until PUBLIC_BASE_URL is set.
 */
export function tiktokWebhookCallbackUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/public/channels/tiktok/webhook`;
}
