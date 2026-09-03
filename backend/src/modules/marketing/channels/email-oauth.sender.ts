import { EMAIL_OAUTH, EmailOAuthProvider } from './email-oauth.config';

/**
 * Sending a mail on a connected mailbox's behalf, over HTTP rather than SMTP.
 *
 * See `email-oauth.config.ts` for why this is HTTP: Gmail's SMTP server only
 * accepts the restricted `https://mail.google.com/` scope, which would put the
 * whole product on a paid annual security assessment. The send-only scope works
 * against the Gmail API and nowhere else.
 */

const SEND_TIMEOUT_MS = 20_000;

/** What a channel's sealed secrets carry once a mailbox is connected. */
export interface EmailOAuthSecrets {
  oauthProvider?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  /** Epoch millis. Absent on a token minted before this field existed. */
  oauthExpiresAt?: string;
  fromEmail?: string;
}

export interface OAuthSendInput {
  provider: EmailOAuthProvider;
  accessToken: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface RefreshedToken {
  accessToken: string;
  /** Epoch millis. */
  expiresAt: number;
  /** Providers may rotate it; when they do, the old one stops working. */
  refreshToken?: string;
}

/** Base64url — the Gmail API rejects standard base64 padding. */
function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 822 for the Gmail API.
 *
 * The subject is encoded even when it looks plain: this product's customers
 * write Turkish, and a bare `Subject: Ücretsiz çekirdek` is 8-bit in a header
 * that is specified as ASCII — some servers pass it, some mangle it, and the
 * ones that mangle it do so silently.
 */
export function buildRfc822({ from, to, subject, text }: Omit<OAuthSendInput, 'provider' | 'accessToken'>): string {
  const encoded = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encoded}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
  ].join('\r\n');
}

async function post(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** The provider's own words, or a status line — never a paraphrase, because
 *  this string is what the operator pastes into a support thread. */
function reason(status: number, body: any): string {
  const msg = body?.error?.message ?? body?.error_description ?? body?.error ?? '';
  return `${status}${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : ''}`;
}

/** Flat by design: `strictNullChecks` is off in this build, so a discriminated
 *  union does not narrow on `ok` and every reader would need a cast. */
export interface OAuthSendResult {
  ok: boolean;
  externalId: string | null;
  error: string | null;
}

export async function sendViaOAuth(input: OAuthSendInput): Promise<OAuthSendResult> {
  if (input.provider === 'GOOGLE') {
    const raw = base64url(buildRfc822(input));
    const r = await post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!r.ok) return { ok: false, externalId: null, error: `Gmail ${reason(r.status, r.body)}` };
    return { ok: true, externalId: r.body?.id ? String(r.body.id) : null, error: null };
  }

  const r = await post('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: input.subject,
        body: { contentType: 'Text', content: input.text },
        toRecipients: [{ emailAddress: { address: input.to } }],
      },
      saveToSentItems: true,
    }),
  });
  // Graph answers 202 with an EMPTY body and no message id. There is nothing to
  // return, and inventing one would put a fake id on the row.
  if (!r.ok) return { ok: false, externalId: null, error: `Microsoft ${reason(r.status, r.body)}` };
  return { ok: true, externalId: null, error: null };
}

/**
 * Trade the refresh token for a fresh access token.
 *
 * Access tokens last an hour; a channel connected on Monday must still send on
 * Friday without anyone touching it, which is the entire promise of connecting
 * a mailbox once.
 */
export async function refreshAccessToken(
  provider: EmailOAuthProvider,
  refreshToken: string,
): Promise<RefreshedToken | { error: string }> {
  const cfg = EMAIL_OAUTH[provider];
  const clientId = process.env[cfg.clientIdEnv];
  const clientSecret = process.env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) return { error: `${provider} mail app is not configured on this deployment` };

  const r = await post(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!r.ok || !r.body?.access_token) return { error: `${provider} token refresh ${reason(r.status, r.body)}` };

  // 60s of slack: a token that expires while in flight fails the send, and the
  // cost of refreshing a minute early is one extra HTTP call.
  const ttl = Number(r.body.expires_in) || 3600;
  return {
    accessToken: String(r.body.access_token),
    expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000,
    // Google usually omits it (the original stays valid); Microsoft rotates it.
    // Persisting only when present is what keeps a rotating provider working
    // and a non-rotating one from having its token overwritten with undefined.
    ...(r.body.refresh_token ? { refreshToken: String(r.body.refresh_token) } : {}),
  };
}

/** True when the stored access token is missing or within its slack window. */
export function needsRefresh(secrets: EmailOAuthSecrets, now: number = Date.now()): boolean {
  if (!secrets.oauthAccessToken) return true;
  const at = Number(secrets.oauthExpiresAt);
  // No expiry recorded: the token predates this field, so its age is unknown
  // and the safe reading is "expired" — one wasted refresh beats a dead send.
  if (!Number.isFinite(at)) return true;
  return at <= now;
}
