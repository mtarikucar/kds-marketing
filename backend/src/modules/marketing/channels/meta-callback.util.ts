/**
 * The Meta webhook callback URL operators paste into the Meta App dashboard.
 * STATIC — one app / one URL for ALL Meta channels (WhatsApp/Messenger/IG); the
 * trust boundary is the X-Hub-Signature-256 HMAC + the verify token, so there's
 * no per-channel token in the path (unlike the unsigned NetGSM MO callback).
 * Null until PUBLIC_BASE_URL is set (mask() degrades, same as the SMS callback).
 */
export function metaWebhookCallbackUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/public/channels/meta/webhook`;
}
