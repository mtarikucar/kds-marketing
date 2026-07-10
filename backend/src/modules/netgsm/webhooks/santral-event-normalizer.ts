/**
 * Netsantral "URL'e Yönlendirme" scenario → typed domain-event normalizer.
 *
 * NetGSM's cloud PBX pushes one raw JSON record per call-leg scenario
 * (Inbound_call / Answer / Hangup / a CDR-style end-of-call record). Field
 * NAMES vary by scenario/firmware (snake_case, Turkish, camelCase), so every
 * field is picked tolerantly across the documented alternates (see the
 * Phase-3 plan's "Key santral-event facts"). `unique_id` additionally arrives
 * with an `sip<digits>-` prefix on some deliveries — stripped here because
 * downstream correlation (Task 2's telephony consumer, and the control
 * endpoints hangup/xfer/atxfer/muteaudio) all key off the bare id — while
 * `raw` keeps the untouched original payload for audit.
 *
 * An unrecognized scenario returns `null` for the WHOLE event (never a
 * partially-typed one): the caller (NetgsmEventsController) still archives
 * the raw payload regardless, it just never publishes a typed
 * `marketing.telephony.call_event.v1` for it — the same fail-closed shape as
 * the İYS route's unknown-status/type skip.
 */
export type SantralEventKind = 'inbound_call' | 'answer' | 'hangup' | 'cdr';

export interface SantralEvent {
  kind: SantralEventKind;
  uniqueId: string | null;
  crmId: string | null;
  customerNum: string | null;
  internalNum: string | null;
  direction: 'INBOUND' | 'OUTBOUND' | null;
  status: string | null;
  recording: string | null;
  durationSec: number | null;
  raw: object;
}

const SIP_PREFIX_RE = /^sip\d+-/i;

/** First non-empty value across the given (tolerant) key alternates, as a string. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Same alternates, coerced to a finite number (numeric string or number). Non-numeric/garbage → null. */
function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickKind(obj: Record<string, unknown>): SantralEventKind | null {
  const raw = pickString(obj, ['scenario', 'durum', 'event']);
  if (!raw) return null;
  switch (raw.toLowerCase()) {
    case 'inbound_call':
      return 'inbound_call';
    case 'answer':
      return 'answer';
    case 'hangup':
      return 'hangup';
    case 'cdr':
    case 'end':
      return 'cdr';
    default:
      return null;
  }
}

function pickDirection(obj: Record<string, unknown>): 'INBOUND' | 'OUTBOUND' | null {
  const raw = pickString(obj, ['yon', 'direction']);
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v.startsWith('in')) return 'INBOUND';
  if (v.startsWith('out')) return 'OUTBOUND';
  return null;
}

export function normalizeSantralEvent(raw: unknown): SantralEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const kind = pickKind(obj);
  if (!kind) return null;

  const rawUniqueId = pickString(obj, ['unique_id', 'uniqueid', 'uniqueId', 'callid']);
  const uniqueId = rawUniqueId ? rawUniqueId.replace(SIP_PREFIX_RE, '') : null;

  return {
    kind,
    uniqueId,
    crmId: pickString(obj, ['crm_id']),
    customerNum: pickString(obj, ['customer_num', 'arayan', 'caller']),
    internalNum: pickString(obj, ['internal_num', 'aranan', 'dahili']),
    direction: pickDirection(obj),
    status: pickString(obj, ['sondurum', 'status']),
    recording: pickString(obj, ['seskaydi', 'recording']),
    durationSec: pickNumber(obj, ['bilsec', 'billsec', 'duration']),
    raw: obj,
  };
}
