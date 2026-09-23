import { imapForSmtpHost } from './smtp-autodiscover';

/**
 * WHERE the incoming mail lives, HOW to connect to it, and WHAT a failed
 * connection meant — answered once, for both IMAP services.
 *
 * ## Why one file
 *
 * `EmailImapPollService` (the five-minute guarantee) and `EmailImapIdleService`
 * (the held connection that makes a reply arrive in a second) each used to
 * work the host, the port and the TLS mode out for themselves, from the same
 * secrets, in code that had already drifted: one hard-coded `secure: true`, so
 * a 143-only server could never work, and the other repeated the same
 * assumption a few lines apart. Two services connecting to the same mailbox
 * must not be able to disagree about how, so the answer lives here and they
 * both read it.
 *
 * ## The refusal is the feature
 *
 * `imapTarget` returns a REASON rather than a bare null, because the three
 * ways it can decline are three different things to a caller:
 *   - `oauth` — a consent-connected mailbox, whose tokens belong to the
 *     refresh cron. Nothing to see; never log it as a problem.
 *   - `no-credentials` — half-configured, or send-only.
 *   - `no-host` — the provider is not in the table and nobody typed a host.
 *     This one deliberately does NOT fall back to the SMTP host: that would
 *     start five-minutely logins, and an IDLE reconnect loop, against hosts
 *     nobody has proven — including pure-outbound relays that have no IMAP at
 *     all. The dialog suggests "same as SMTP"; the pollers never assume it.
 */

export interface ImapTarget {
  host: string;
  port: number;
  /**
   * Implicit TLS — true only on the IMAPS ports. Everything else has to
   * UPGRADE, and `imapConnectOptions` demands it rather than hoping for it.
   */
  secure: boolean;
  user: string;
  pass: string;
}

export type ImapTargetRefusal = 'oauth' | 'no-credentials' | 'no-host';

/**
 * A STRING discriminant, not a boolean one.
 *
 * This project compiles with `strictNullChecks: false`, where TypeScript does
 * not narrow a union on a boolean-literal field — `if (!r.ok) …` left
 * `r.reason` an error, and every caller grew its own workaround (`'target' in
 * r` in one, a flat cast in another). A string literal narrows regardless, so
 * the three callers can all just ask.
 */
export type ImapTargetResult =
  | { kind: 'ok'; target: ImapTarget }
  | { kind: 'refused'; reason: ImapTargetRefusal };

/**
 * 993 is IMAPS; 994 is the historical alternative some hosts still answer on.
 * 465 is deliberately absent — that is SMTPS, and a mistyped 465 should fail
 * loudly on the handshake instead of quietly attempting the wrong protocol.
 */
const IMPLICIT_TLS_PORTS = new Set([993, 994]);

/** Bounded so a mail host that stops answering cannot hold a socket forever. */
const CONNECT_TIMEOUT_MS = 20_000;

/** The server's own words, kept short enough for a JSON column and a card. */
const MAX_ERROR_CHARS = 300;

/**
 * Resolve a channel's stored secrets into something connectable.
 *
 * ## Consent does not mean send-only any more
 *
 * A mailbox connected by consent used to be refused here outright, and that
 * cost every such tenant their entire inbound half: Gmail's `readonly` scope
 * needs a CASA security assessment, so "wait for the OAuth read scope" meant
 * "no replies, indefinitely". A password is not the only way in, but it is a
 * way in that exists today — so a consent mailbox that ALSO holds a receive
 * credential is polled with it (consent for send, app password for receive,
 * no new scope and nobody to wait for).
 *
 * The refusal only fires when there is genuinely nothing to connect WITH, and
 * it still says `oauth` in that case so the pollers log it at debug: a
 * send-only consent mailbox is an expected state, not a fault.
 *
 * `imapUser`/`imapPass` outrank the SMTP pair because consent never touches
 * them (`deadSmtpKeys`), which makes them the mailbox's stable answer to "how
 * do I read this".
 */
export function imapTarget(
  secrets: Record<string, string | undefined> | null | undefined,
): ImapTargetResult {
  const s = secrets ?? {};
  const dedicatedUser = s.imapUser?.trim();
  const user = dedicatedUser || s.smtpUser?.trim();
  const pass = dedicatedUser ? s.imapPass : s.smtpPass;
  if (!user || !pass) {
    // Consent with no receive credential beside it: send-only by design, and
    // nothing for an operator to fix.
    return { kind: 'refused', reason: s.oauthProvider ? 'oauth' : 'no-credentials' };
  }

  const discovered = imapForSmtpHost(s.smtpHost ?? '');
  const host = s.imapHost?.trim() || discovered?.host;
  if (!host) return { kind: 'refused', reason: 'no-host' };

  const port = Number(s.imapPort) || discovered?.port || 993;
  // Mirrors `smtpSecure`. Deriving TLS from the port alone leaves a tenant
  // whose host serves IMAPS on anything but 993/994 permanently unable to
  // receive: imapflow demands STARTTLS, the server never offers it, and no
  // setting can say otherwise.
  const secure = s.imapSecure === 'true' || IMPLICIT_TLS_PORTS.has(port);
  return { kind: 'ok', target: { host, port, secure, user, pass } };
}

/**
 * The ImapFlow options for a target.
 *
 * `doSTARTTLS: true` on a plaintext port is load-bearing: without it imapflow
 * falls back to OPPORTUNISTIC STARTTLS and sends LOGIN in the clear against a
 * server that advertises no upgrade. With it, the connect throws and the
 * failure is visible instead of being a password on the wire.
 *
 * `socketTimeout` is opt-in for the same reason it is not a constant: the
 * poller is always talking and wants a dead socket cut off, while a held IDLE
 * connection is SILENT by design and a socket timeout would kill a perfectly
 * good mailbox every twenty seconds.
 */
export function imapConnectOptions(
  target: ImapTarget,
  opts: { timeoutMs?: number; socketTimeoutMs?: number } = {},
): Record<string, unknown> {
  const timeout = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return {
    host: target.host,
    port: target.port,
    secure: target.secure,
    ...(target.secure ? {} : { doSTARTTLS: true }),
    auth: { user: target.user, pass: target.pass },
    logger: false,
    greetingTimeout: timeout,
    connectionTimeout: timeout,
    ...(opts.socketTimeoutMs ? { socketTimeout: opts.socketTimeoutMs } : {}),
  };
}

/** What a failed IMAP connection was, in the shape `MailboxHealthService.recordBackoff` takes. */
export interface ImapFailure {
  /** The server's own error, never a paraphrase — this is for the operator. */
  error: string;
  /** Machine code the health card maps to copy. */
  reason: 'AUTH_FAILED' | 'CONNECT_FAILED';
  /** Only picks the BACKOFF CEILING. It never decides whether to retry. */
  authFailure: boolean;
}

/** Node/imapflow's codes for "the network got in the way", never a credential. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ESOCKET',
  'ECONNECTION',
]);

const AUTH_TEXT = [
  /AUTHENTICATIONFAILED/i,
  /authentication\s+fail/i,
  /invalid\s+credentials/i,
  /(login|authenticate)\s+(failed|denied|rejected)/i,
  /application-specific password/i,
  /web\s+login\s+required/i,
];

/**
 * Classify a failed hold so the wait can be given the right ceiling and the
 * tenant can be told something true.
 *
 * It classifies; it does NOT decide to give up. "Stop on auth failure until
 * the credentials change" would let one transient `AUTHENTICATIONFAILED` —
 * provider maintenance, throttling, Gmail answering "too many simultaneous
 * connections" as an auth error — kill a mailbox's inbound permanently,
 * recoverable only by a human noticing. Mail silently missing for days is a
 * worse failure than log noise, so a credential failure waits longer and then
 * tries again.
 */
export function classifyImapError(e: unknown): ImapFailure {
  const err: any = typeof e === 'string' ? { message: e } : (e ?? {});
  const text = [err.message, err.response, err.responseText, err.serverResponseCode]
    .filter((v) => typeof v === 'string' && v)
    .join(' ');
  const error = (text || 'IMAP connection failed').slice(0, MAX_ERROR_CHARS);
  const code = String(err.code ?? '');

  // The network answer wins: a refused socket carrying the word "login" in a
  // hostname is not a rejected password, and must not earn the six-hour wait.
  const networkFailure = NETWORK_CODES.has(code) || /timeout|timed out/i.test(text);
  const authFailure =
    !networkFailure && (err.authenticationFailed === true || AUTH_TEXT.some((re) => re.test(text)));

  return { error, reason: authFailure ? 'AUTH_FAILED' : 'CONNECT_FAILED', authFailure };
}
