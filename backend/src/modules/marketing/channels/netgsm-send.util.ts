/**
 * NetGSM `/sms/send/get` returns a plain-text line: a status code, optionally
 * followed by a job (bulk) id — e.g. "00 9988776655" on success, or a bare
 * error code like "30". This turns that line into a structured, actionable
 * outcome so callers can surface a meaningful error and decide whether a retry
 * is worthwhile. Codes per NetGSM's documented send-API contract.
 */
export interface NetgsmSendOutcome {
  ok: boolean;
  /** The raw status code NetGSM returned (first whitespace-delimited token). */
  code: string;
  /** Job/bulk id on success; null otherwise. */
  jobId: string | null;
  /** Human-actionable error message; null on success. */
  message: string | null;
  /** True only when retrying the SAME request could plausibly succeed. */
  retriable: boolean;
}

const OK_CODES = new Set(['00', '01', '02']);

/** Documented error codes → operator-actionable English. */
const ERROR_MESSAGES: Record<string, string> = {
  '20':
    'Message rejected: the text is empty, too long, or contains an unsupported character (NetGSM code 20).',
  '30':
    'NetGSM authentication failed: verify the API sub-user usercode/password, that API access is activated, and that the server IP is allow-listed (code 30).',
  '40':
    'Sender header (msgheader) is not defined or not İYS-approved on the NetGSM account (code 40).',
  '50':
    'İYS: the recipient has no commercial-message permission or is on the opt-out registry (code 50).',
  '51':
    'İYS: the sender brand/title is not registered with İYS for commercial messaging (code 51).',
  '60': 'NetGSM account or sub-user is not authorised for this operation (code 60).',
  '70': 'Invalid or missing request parameters were sent to NetGSM (code 70).',
  '80': 'NetGSM sending rate limit exceeded — retry after a short delay (code 80).',
  '85':
    'NetGSM duplicate-message limit exceeded for this recipient/content; the same text was sent too recently (code 85).',
};

/** Only transient throttling (80) eases on its own; everything else needs a fix. */
const RETRIABLE_CODES = new Set(['80']);

export function interpretNetgsmSend(rawBody: string): NetgsmSendOutcome {
  const body = (rawBody ?? '').trim();
  const [code = '', jobId] = body.split(/\s+/);

  if (OK_CODES.has(code)) {
    return { ok: true, code, jobId: jobId ?? null, message: null, retriable: false };
  }

  if (!code) {
    return {
      ok: false,
      code: '',
      jobId: null,
      message: 'NetGSM returned an empty response (no status code).',
      retriable: false,
    };
  }

  const message = ERROR_MESSAGES[code] ?? `NetGSM rejected the send (code ${code}).`;
  return { ok: false, code, jobId: null, message, retriable: RETRIABLE_CODES.has(code) };
}
