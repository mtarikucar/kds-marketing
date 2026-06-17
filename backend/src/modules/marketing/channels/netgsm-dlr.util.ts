/**
 * Maps a NetGSM polled-report `durumcode` (+ optional `hatakod` reason) to our
 * Message.status, and tells the poller whether the state is terminal (delivered/
 * failed → stop polling) or still pending (keep the message SENT and re-poll).
 * Codes per NetGSM's documented `/sms/report` contract.
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
