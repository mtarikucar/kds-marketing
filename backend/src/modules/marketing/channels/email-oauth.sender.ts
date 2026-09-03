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
  /**
   * The provider's last refusal, recorded by the refresh sweep. Present means
   * the owner has to reconnect; the UI reads it to say so before a send fails
   * on a customer.
   */
  oauthError?: string;
}

export interface OAuthSendInput {
  provider: EmailOAuthProvider;
  accessToken: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * Flat, like `OAuthSendResult` and for the same reason: `strictNullChecks` is
 * off in this build, so `{...} | {error}` does not narrow and every caller
 * would need a cast. `error` non-null means nothing else is meaningful.
 */
export interface TokenResult {
  accessToken: string | null;
  /** Epoch millis. */
  expiresAt: number | null;
  /**
   * Non-null ONLY when the provider actually issued one. Google omits it on a
   * refresh (the original stays valid) and Microsoft rotates it; writing this
   * through unconditionally would delete a working credential.
   */
  refreshToken: string | null;
  error: string | null;
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
): Promise<TokenResult> {
  return tokenRequest(provider, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

/**
 * Trade the one-time authorization code for the pair that connects the mailbox.
 *
 * Unlike a refresh, this MUST come back with a refresh token — an access token
 * alone connects a channel that works for an hour and then stops, which looks
 * like a bug days later and far from this code. The providers are configured to
 * guarantee one (`access_type=offline`+`prompt=consent`, `offline_access`), so
 * its absence means the consent did not grant what we asked for, and refusing
 * here is what keeps that from being sealed onto a channel.
 */
export async function exchangeCodeForTokens(
  provider: EmailOAuthProvider,
  code: string,
  redirectUri: string,
): Promise<TokenResult> {
  const r = await tokenRequest(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  if (r.error) return r;
  if (!r.refreshToken) {
    return { accessToken: null, expiresAt: null, refreshToken: null, error: `${provider} did not return a refresh token` };
  }
  return r;
}

/** Shared token-endpoint call. Both grants post the same form to the same URL
 *  and read the same response; only the grant-specific fields differ. */
async function tokenRequest(
  provider: EmailOAuthProvider,
  grantFields: Record<string, string>,
): Promise<TokenResult> {
  const fail = (error: string): TokenResult => ({ accessToken: null, expiresAt: null, refreshToken: null, error });
  const cfg = EMAIL_OAUTH[provider];
  const clientId = process.env[cfg.clientIdEnv];
  const clientSecret = process.env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) return fail(`${provider} mail app is not configured on this deployment`);

  const r = await post(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...grantFields, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  if (!r.ok || !r.body?.access_token) return fail(`${provider} token request ${reason(r.status, r.body)}`);

  // 60s of slack: a token that expires while in flight fails the send, and the
  // cost of refreshing a minute early is one extra HTTP call.
  const ttl = Number(r.body.expires_in) || 3600;
  return {
    accessToken: String(r.body.access_token),
    expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000,
    refreshToken: r.body.refresh_token ? String(r.body.refresh_token) : null,
    error: null,
  };
}

/**
 * Which mailbox was just connected.
 *
 * Asked rather than typed: the alternative is a form field where the owner
 * writes the address they just authenticated, and a typo there produces a
 * channel that sends from one account while claiming another — mail that
 * arrives, fails alignment, and lands in spam for reasons nobody can see.
 */
export async function fetchConnectedAddress(
  provider: EmailOAuthProvider,
  accessToken: string,
): Promise<string | null> {
  const url =
    provider === 'GOOGLE'
      ? 'https://www.googleapis.com/oauth2/v3/userinfo'
      : 'https://graph.microsoft.com/v1.0/me';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body: any = await res.json().catch(() => ({}));
  // Graph's `mail` is null on accounts with no Exchange licence; the UPN is the
  // address in that case and is what the mailbox actually sends as.
  const raw = provider === 'GOOGLE' ? body?.email : (body?.mail ?? body?.userPrincipalName);
  return typeof raw === 'string' && raw.includes('@') ? raw.trim().toLowerCase() : null;
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
