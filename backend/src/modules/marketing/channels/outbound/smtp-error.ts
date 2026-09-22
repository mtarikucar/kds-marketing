/**
 * What a failed send MEANS.
 *
 * Today every error is the same thing. The campaign sender writes `FAILED` and
 * moves on, so one minute of a down relay burns a whole audience permanently
 * (`campaign-failures-terminal`), and an AI reply that hit a 4xx is never tried
 * again (`ai-transient-final`).
 *
 * The other half of the same mistake is worse. Treating any 5xx as a dead
 * address would suppress a whole list the first time a receiver answered
 * `550 5.7.1` to a policy check (`sync-5xx-no-suppress` asks for suppression;
 * it must be the RIGHT 5xx). So the bounce set is an ALLOW-LIST: the enhanced
 * codes that mean "this mailbox does not exist", and nothing else. Everything
 * else 5xx is `unknown` — honest, terminal for this attempt, and not a reason
 * to suppress anybody.
 *
 * Two answers, deliberately separate:
 *   `kind`      — what the QUEUE should do (the campaign sender reverts
 *                 SENDING→PENDING on transient/systemic).
 *   `retriable` — whether sending THIS message again, as-is, could succeed.
 * An auth refusal is systemic but not retriable: the credentials will not be
 * different on the second attempt.
 */

export type SmtpErrorKind = 'transient' | 'systemic' | 'permanent-recipient' | 'unknown';

export interface SmtpClassification {
  kind: SmtpErrorKind;
  retriable: boolean;
  /** The 3-digit SMTP status, when there was one. */
  code?: number;
  /** The enhanced status code (RFC 3463), when there was one. */
  enhanced?: string;
}

/** Nodemailer's codes for "the network got in the way". */
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ECONNECTION', 'EDNS']);

/** SMTP's own auth refusals. */
const AUTH_CODES = new Set([530, 534, 535]);

/**
 * The only enhanced codes that mean the MAILBOX is gone. Everything else in
 * 5.x.y is about the sender, the message or the policy — 5.7.1 is a blocklist,
 * 5.3.4 is "too big", 5.1.8 is our own sender address being refused.
 */
const RECIPIENT_GONE_ENHANCED = new Set(['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10']);

/** Statuses that MAY carry a recipient bounce when no enhanced code is given. */
const RECIPIENT_GONE_CODES = new Set([550, 551, 553]);

const RECIPIENT_GONE_TEXT = [/user unknown/i, /no such user/i, /recipient address rejected/i];

/** Our own systemic refusals, recognised by their words. */
const SYSTEMIC_TEXT = [
  /MESSAGES_EXHAUSTED/,
  /SMTP credentials missing/i,
  /PUBLIC_BASE_URL not configured/i,
];

const TRANSIENT_TEXT = [/too many connections/i, /try again shortly/i];

const ENHANCED_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
/** A bare 3-digit status, not a number that happens to appear in prose. */
const STATUS_RE = /(?:^|[\s(])([2-5]\d{2})(?:[ -]|$)/;

function result(kind: SmtpErrorKind, retriable: boolean, code?: number, enhanced?: string): SmtpClassification {
  return {
    kind,
    retriable,
    ...(code ? { code } : {}),
    ...(enhanced ? { enhanced } : {}),
  };
}

/**
 * Classify anything a send path can hand back: a nodemailer error, a Nest
 * exception (MessageQuotaService throws one, with the code on the response
 * OBJECT where nodemailer keeps a response STRING), a plain `Error`, or the
 * bare error string the adapter returns — which is all the campaign sender has.
 */
export function classifySmtpError(e: unknown): SmtpClassification {
  if (!e || (typeof e !== 'object' && typeof e !== 'string')) return result('unknown', false);

  const err: any = typeof e === 'string' ? { message: e } : e;
  const responseIsObject = err.response && typeof err.response === 'object';
  const text = [
    typeof err.message === 'string' ? err.message : '',
    typeof err.response === 'string' ? err.response : '',
    responseIsObject && typeof err.response.message === 'string' ? err.response.message : '',
  ]
    .filter(Boolean)
    .join(' ');

  const errCode = String(err.code ?? (responseIsObject ? err.response.code : '') ?? '');
  const command = String(err.command ?? '');

  const enhancedMatch = ENHANCED_RE.exec(text);
  const enhanced = enhancedMatch ? enhancedMatch[0] : undefined;

  const statusMatch = STATUS_RE.exec(text);
  const code =
    Number.isFinite(err.responseCode) && err.responseCode >= 100 && err.responseCode <= 599
      ? Number(err.responseCode)
      : statusMatch
        ? Number(statusMatch[1])
        : undefined;

  // Auth first, and never retriable: the same rejected credentials cannot
  // succeed on a second attempt, whatever else the error says about itself.
  if (errCode === 'EAUTH' || AUTH_CODES.has(code)) return result('systemic', false, code, enhanced);

  if (errCode === 'MESSAGES_EXHAUSTED' || SYSTEMIC_TEXT.some((re) => re.test(text))) {
    return result('systemic', false, code, enhanced);
  }

  // A timeout at DATA is the one failure we refuse to guess about: nodemailer
  // cannot tell accepted-then-timed-out from rejected, and a retry there puts a
  // second copy of a real mail in a customer's inbox.
  const timedOut = errCode === 'ETIMEDOUT' || errCode === 'ESOCKET' || /timeout/i.test(text);
  if (timedOut && (command === 'DATA' || /\bDATA\b/.test(text))) {
    return result('unknown', false, code, enhanced);
  }

  if (NETWORK_CODES.has(errCode)) return result('transient', true, code, enhanced);

  // Every 4xx is a "try later" by definition — the four the audit named are the
  // ones seen in the wild, but the class is what matters.
  if (code >= 400 && code < 500) return result('transient', true, code, enhanced);

  if (code >= 500 && code < 600) {
    if (enhanced) {
      // An explicit enhanced code beats the prose beside it: `550 5.1.8 Sender
      // address rejected` reads like a recipient bounce and is not one.
      return RECIPIENT_GONE_ENHANCED.has(enhanced)
        ? result('permanent-recipient', false, code, enhanced)
        : result('unknown', false, code, enhanced);
    }
    if (RECIPIENT_GONE_CODES.has(code) && RECIPIENT_GONE_TEXT.some((re) => re.test(text))) {
      return result('permanent-recipient', false, code);
    }
    return result('unknown', false, code);
  }

  if (TRANSIENT_TEXT.some((re) => re.test(text))) return result('transient', true, code, enhanced);

  return result('unknown', false, code, enhanced);
}
