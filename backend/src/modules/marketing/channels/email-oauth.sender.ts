import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { assertNoHeaderInjection } from '../../../common/util/email-address';
import { toHeaderMessageId } from './email-message-id';
import { EMAIL_OAUTH, EmailOAuthProvider } from './email-oauth.config';

/** This module is plain functions, not a provider, so it carries its own. */
const LOGGER = new Logger('EmailOAuthSender');

/**
 * Sending a mail on a connected mailbox's behalf, over HTTP rather than SMTP.
 *
 * See `email-oauth.config.ts` for why this is HTTP: Gmail's SMTP server only
 * accepts the restricted `https://mail.google.com/` scope, which would put the
 * whole product on a paid annual security assessment. The send-only scope works
 * against the Gmail API and nowhere else.
 */

const SEND_TIMEOUT_MS = 20_000;
const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

/**
 * What a provider grants when it says nothing, and how early a token is called
 * dead. Exported because `email-oauth-refresh.service.ts` times its sweep
 * against them: the tick has to be shorter than `TTL - slack` or a refreshed
 * token dies before the sweep comes back to it.
 */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;
export const ACCESS_TOKEN_SLACK_SECONDS = 60;

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
  /** The display name beside `from`, never folded into it — see `buildRfc822`. */
  fromName?: string;
  /** Where an answer should go when that is not the sending mailbox. */
  replyTo?: string;
  /** Sent ALONGSIDE `text`, never instead of it — see `buildRfc822`. */
  html?: string;
  /** Bare or bracketed; this file writes the brackets. */
  inReplyTo?: string | null;
  references?: string[];
  /** The gateway's own deterministic id, bare — this file writes the brackets. */
  messageId?: string;
  autoSubmitted?: 'auto-generated' | 'auto-replied';
}

/** Everything `buildRfc822` needs — the transport fields are not its business. */
export type Rfc822Input = Omit<OAuthSendInput, 'provider' | 'accessToken'>;

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

/** RFC 5322 §2.1.1 hard-limits a line to 998 characters; RFC 2045 §6.8 limits
 *  a base64 line to 76. A relay with a shorter limit chops the line, which
 *  breaks the body hash of the provider's DKIM signature and fails DMARC. */
const BASE64_LINE_RE = /.{1,76}/g;
/** An encoded-word is at most 75 characters, of which `=?UTF-8?B?` + `?=` take
 *  12. That leaves 63, rounded down to a whole base64 quantum: 60 characters,
 *  which is 45 bytes of subject. */
const SUBJECT_CHUNK_BYTES = 45;
/** Where a list header starts a continuation line. Well under 998, so a long
 *  References chain never reaches the hard limit. */
const FOLD_AT = 78;

function base64Lines(value: string): string {
  return (Buffer.from(value, 'utf8').toString('base64').match(BASE64_LINE_RE) ?? []).join('\r\n');
}

/**
 * A header's text as one or more RFC 2047 encoded-words.
 *
 * Chunked on CODE POINTS rather than bytes: splitting mid-sequence corrupts
 * exactly the Turkish letters this encoding exists to carry. Adjacent words
 * separated by folding whitespace are concatenated on decode (RFC 2047 §5).
 */
function encodeWords(subject: string): string {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of subject) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (chunk && bytes + size > SUBJECT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += size;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** A list header folded onto continuation lines (RFC 5322 §2.2.3) — a
 *  References chain outgrows one line after a few dozen replies. */
function foldList(name: string, values: string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const v of values) {
    if (line !== `${name}:` && line.length + 1 + v.length > FOLD_AT) {
      lines.push(line);
      line = '';
    }
    line += ` ${v}`;
  }
  lines.push(line);
  return lines.join('\r\n');
}

/** Threading headers, bracketed here so callers can hold the id either way.
 *  An empty value produces no header at all: an empty `In-Reply-To` threads
 *  nowhere and some receivers reject it outright. */
function threadingHeaders(inReplyTo?: string | null, references?: string[]): string[] {
  const out: string[] = [];
  const irt = toHeaderMessageId(inReplyTo);
  if (irt) out.push(`In-Reply-To: ${irt}`);
  const refs = (references ?? []).map((r) => toHeaderMessageId(r)).filter(Boolean) as string[];
  if (refs.length) out.push(foldList('References', refs));
  return out;
}

/**
 * The From header value: the address alone, or an encoded display name in
 * front of an angle-bracketed address.
 *
 * ALWAYS encoded, never quoted. A tenant's trade name routinely carries a
 * Turkish letter (8-bit in a header specified as ASCII) or a quote character,
 * and a hand-built `"name" <addr>` gets the second one wrong in a way that
 * rewrites the address (`no-display-name`). nodemailer does this for the SMTP
 * transport; here there is no nodemailer.
 */
function fromHeader(address: string, name?: string): string {
  const display = (name ?? '').trim();
  return display ? `${encodeWords(display)} <${address}>` : address;
}

function bodyPart(contentType: string, content: string): string[] {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(content),
  ];
}

/**
 * RFC 822 for the provider APIs.
 *
 * Three things this has to get right, because it composes a message by joining
 * strings and nothing downstream re-checks it:
 *
 * - A CR/LF in a header value writes headers. That is real injection, not a
 *   theory, so every caller-supplied header value is refused here as well as
 *   at whatever guard the caller passed first.
 * - The subject is encoded even when it looks plain: this product's customers
 *   write Turkish, and a bare `Subject: Ücretsiz çekirdek` is 8-bit in a header
 *   specified as ASCII — some servers pass it, some mangle it silently.
 * - HTML goes out as a real `multipart/alternative` beside the text, which is
 *   what a consent-connected mailbox needs in order to stop being text-only.
 */
export function buildRfc822(input: Rfc822Input): string {
  const { from, fromName, replyTo, to, subject, text, html, inReplyTo, references } = input;
  const headers = [
    `From: ${fromHeader(
      assertNoHeaderInjection(from ?? '', 'From'),
      assertNoHeaderInjection(fromName ?? '', 'From'),
    )}`,
    `To: ${assertNoHeaderInjection(to ?? '', 'To')}`,
    ...(replyTo?.trim() ? [`Reply-To: ${assertNoHeaderInjection(replyTo, 'Reply-To')}`] : []),
    `Subject: ${encodeWords(assertNoHeaderInjection(subject ?? '', 'Subject'))}`,
    ...(toHeaderMessageId(input.messageId) ? [`Message-ID: ${toHeaderMessageId(input.messageId)}`] : []),
    ...(input.autoSubmitted ? [`Auto-Submitted: ${input.autoSubmitted}`] : []),
    ...threadingHeaders(inReplyTo, references),
    'MIME-Version: 1.0',
  ];
  const markup = (html ?? '').trim();
  if (!markup) return [...headers, ...bodyPart('text/plain', text ?? '')].join('\r\n');

  const boundary = `----=_Part_${randomBytes(12).toString('hex')}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    // Least rich first: that is what "alternative" asks a client to prefer.
    `--${boundary}`,
    ...bodyPart('text/plain', text ?? ''),
    `--${boundary}`,
    ...bodyPart('text/html', markup),
    `--${boundary}--`,
    '',
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

/**
 * The header values a caller supplied, refused before anything is composed.
 *
 * Checked here rather than only inside `buildRfc822` because the Graph JSON
 * shape builds no MIME at all and would hand the poisoned value straight to
 * the provider. Returns the message instead of throwing: nothing new throws
 * out of a transport (G2).
 */
function headerRefusal(input: OAuthSendInput): string | null {
  try {
    assertNoHeaderInjection(input.from ?? '', 'From');
    assertNoHeaderInjection(input.fromName ?? '', 'From');
    assertNoHeaderInjection(input.replyTo ?? '', 'Reply-To');
    assertNoHeaderInjection(input.to ?? '', 'To');
    assertNoHeaderInjection(input.subject ?? '', 'Subject');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function sendViaOAuth(input: OAuthSendInput): Promise<OAuthSendResult> {
  const refusal = headerRefusal(input);
  if (refusal) return { ok: false, externalId: null, error: refusal };

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

  // Graph's JSON `message` carries ONE body, so an HTML mail sent that way
  // loses its plain part, and `internetMessageHeaders` accepts `x-`-prefixed
  // names only — so a Message-ID, Auto-Submitted or a threading header has no
  // field to live in either. MIME is the only shape that holds all of them, and
  // it is taken only when one is actually asked for: a plain mail keeps the
  // request proven against Graph. A MIME send is filed in Sent Items too, same
  // as `saveToSentItems: true`.
  const needsMime = !!(
    (input.html ?? '').trim() ||
    input.messageId ||
    input.autoSubmitted ||
    input.inReplyTo ||
    input.references?.length
  );
  const mime = needsMime ? Buffer.from(buildRfc822(input), 'utf8').toString('base64') : null;
  const name = (input.fromName ?? '').trim();
  const replyTo = (input.replyTo ?? '').trim();
  const r = await post(GRAPH_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      // A MIME send posts the base64 message as the whole body.
      'Content-Type': mime ? 'text/plain' : 'application/json',
    },
    body:
      mime ??
      JSON.stringify({
          message: {
            subject: input.subject,
            body: { contentType: 'Text', content: input.text },
            toRecipients: [{ emailAddress: { address: input.to } }],
            // Graph composes the From itself, so the display name and the
            // Reply-To are fields here rather than headers.
            ...(name ? { from: { emailAddress: { address: input.from, name } } } : {}),
            ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
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
  const ttl = Number(r.body.expires_in) || DEFAULT_TOKEN_TTL_SECONDS;
  return {
    accessToken: String(r.body.access_token),
    expiresAt: Date.now() + Math.max(0, ttl - ACCESS_TOKEN_SLACK_SECONDS) * 1000,
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
  }).catch((e) => {
    // The null return is the contract — callers depend on it — but WHY it
    // came back null has to reach a log, or a timeout and a 403
    // insufficient-privileges are the same `?connect_error=1` page and an
    // operator has nothing to act on. Microsoft's `/me` refuses without the
    // `User.Read` scope, which is precisely the failure this names.
    LOGGER.warn(
      `email-oauth: ${provider} identity lookup did not complete: ${String(e?.message ?? e).slice(0, 200)}`,
    );
    return null;
  });
  if (!res) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    LOGGER.warn(
      `email-oauth: ${provider} identity lookup refused (${res.status}): ${detail.slice(0, 300)}`,
    );
    return null;
  }
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
