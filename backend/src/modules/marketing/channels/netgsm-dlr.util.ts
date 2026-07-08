/**
 * Maps a NetGSM polled-report `durumcode` (+ optional `hatakod` reason) to our
 * Message.status, and tells the poller whether the state is terminal (delivered/
 * failed → stop polling) or still pending (keep the message SENT and re-poll).
 * Codes per NetGSM's documented `/sms/report` contract. This is the LEGACY
 * mapping (kept byte-for-byte for legacy-flag channels); `mapNetgsmV2Status`
 * below is the REST v2 `/sms/rest/v2/report` counterpart used by everything
 * else.
 */
export interface NetgsmDlrMapping {
  status: 'DELIVERED' | 'FAILED' | 'SENT';
  /** True once the report is final; the poller stops re-querying this message. */
  terminal: boolean;
  /** Human reason for a failure (stored on Message.error); null otherwise. */
  reason: string | null;
}

const DELIVERED_CODE = '1';
const PENDING_CODE = '0';

/** Failure durumcodes → a base reason. */
const FAIL_REASONS: Record<string, string> = {
  '2': 'delivery failed',
  '3': 'delivery failed',
  '4': 'delivery failed',
  '11': 'delivery failed',
  '12': 'delivery failed',
  '13': 'duplicate message rejected',
  '15': 'recipient blacklisted',
  '16': 'İYS: no commercial-message permission',
  '17': 'İYS: no commercial-message permission',
};

export function mapNetgsmDlr(
  durumcode: string | number,
  hatakod?: string | number,
): NetgsmDlrMapping {
  const durum = String(durumcode ?? '').trim();
  const hataRaw = hatakod == null ? '' : String(hatakod).trim();
  const hata = hataRaw === '' ? null : hataRaw;

  if (durum === DELIVERED_CODE) return { status: 'DELIVERED', terminal: true, reason: null };
  if (durum === PENDING_CODE) return { status: 'SENT', terminal: false, reason: null };

  const base = FAIL_REASONS[durum];
  if (base) {
    const reason = hata
      ? `${base} (durum ${durum}, hata ${hata})`
      : `${base} (durum ${durum})`;
    return { status: 'FAILED', terminal: true, reason };
  }

  // Unrecognized state — don't guess a terminal status; keep SENT and let the
  // message either resolve on a later poll or age out of the poll window.
  return { status: 'SENT', terminal: false, reason: null };
}

/** REST v2 `/sms/rest/v2/report` failure statuses → a base reason. Numeric
 *  keys (unlike the legacy string-keyed FAIL_REASONS above) since
 *  `SmsV2ReportRow.status` is already a parsed `number`. */
const V2_FAIL_REASONS: Record<number, string> = {
  2: 'delivery failed',
  3: 'delivery failed',
  4: 'delivery failed',
  11: 'delivery failed',
  12: 'delivery failed',
  13: 'duplicate message rejected',
  15: 'recipient blacklisted',
  16: 'İYS: no commercial-message permission',
  17: 'İYS: no commercial-message permission',
  22: 'expired',
};

/**
 * Maps a NetGSM REST v2 report row's `status` (+ optional handset `errorCode`,
 * 101-119) to the same `NetgsmDlrMapping` shape `mapNetgsmDlr` produces for the
 * legacy poll, so `NetgsmDlrPollService` can apply either mapping identically.
 * Status enum per the v2 report contract: 1 delivered (terminal) · 0 pending
 * (non-terminal) · 2/3/4/11/12 generic failure · 13 duplicate · 15 blacklist ·
 * 16/17 İYS (no commercial-message consent) · 22 expired (all terminal) ·
 * anything else unrecognized → treated as pending, never guessed terminal.
 */
export function mapNetgsmV2Status(status: number, errorCode?: string | null): NetgsmDlrMapping {
  if (status === 1) return { status: 'DELIVERED', terminal: true, reason: null };
  if (status === 0) return { status: 'SENT', terminal: false, reason: null };

  const base = V2_FAIL_REASONS[status];
  if (base) {
    const code = errorCode != null && String(errorCode).trim() !== '' ? String(errorCode).trim() : null;
    const reason = code ? `${base} (status ${status}, error ${code})` : `${base} (status ${status})`;
    return { status: 'FAILED', terminal: true, reason };
  }

  // Unrecognized status — same "don't guess terminal" rule as mapNetgsmDlr:
  // stay SENT/non-terminal so the poller re-queries it on a later tick.
  return { status: 'SENT', terminal: false, reason: null };
}
