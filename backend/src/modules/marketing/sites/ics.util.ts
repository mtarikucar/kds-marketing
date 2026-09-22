/**
 * Minimal, dependency-free RFC-5545 VEVENT builder for booking mail.
 *
 * Times are emitted as UTC (`YYYYMMDDTHHMMSSZ`). When a `joinUrl` is given the
 * event carries it as URL + LOCATION + X-GOOGLE-CONFERENCE so calendar clients
 * render a one-click join. Text is escaped per the spec (`\ ; , \n`) and
 * content lines are folded at 75 octets.
 *
 * An invite is a REVISION of an appointment, not a snapshot of one. That is
 * what the METHOD / SEQUENCE / DTSTAMP / STATUS quartet says, and what was
 * missing: every invite went out as a fresh `METHOD:REQUEST` stamped with the
 * appointment's own start, so a cancellation could not be expressed at all and
 * a moved appointment arrived as a second, equally-current copy of the first
 * (`booking-cancel-reschedule-ics`). ORGANIZER + ATTENDEE are what make Gmail
 * and Outlook draw an RSVP card instead of degrading the mail to a plain
 * appointment.
 */
export interface IcsInput {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  joinUrl?: string;
  /** The mailbox the business actually reads — never a no-reply address, which
   *  would invite iTIP replies to a mailbox nobody opens. Omitted when the
   *  workspace has no reply address at all. */
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail?: string;
  attendeeName?: string;
  /** `REQUEST` books or moves; `CANCEL` withdraws the SAME uid. */
  method?: IcsMethod;
  /** Revision counter for this uid: later revisions carry a higher one. */
  sequence?: number;
  /** When this revision was produced. Defaults to now — NOT to the start. */
  stamp?: Date;
}

export type IcsMethod = 'REQUEST' | 'CANCEL';

/** RFC 5545 §3.1: a content line is at most 75 OCTETS, continuations begin
 *  with one space (which counts toward the 75). */
const MAX_OCTETS = 75;

function icsDate(d: Date): string {
  // 2026-07-01T10:00:00.000Z -> 20260701T100000Z
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsEscape(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * A parameter value (`CN=…`) has no escape syntax — the separators simply may
 * not appear in one — so they are dropped rather than escaped. A contact called
 * `Ada; Lovelace:` must not be able to invent an ICS parameter.
 */
function icsParam(s: string): string {
  return String(s ?? '')
    .replace(/[;:,"\\]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold one content line to 75 octets, counting UTF-8 bytes and never splitting
 * a character in half — a Turkish `ş` cut down the middle is a mojibake the
 * client shows to the customer.
 */
function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (octets + size > MAX_OCTETS) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n');
}

/** A non-negative whole SEQUENCE; anything else would be an invalid line. */
function icsSequenceValue(v: number | undefined): number {
  if (!Number.isFinite(v as number)) return 0;
  return Math.max(0, Math.floor(v as number));
}

/**
 * A SEQUENCE that rises with each revision, without a column to hold one.
 *
 * RFC 5545 asks only that a later revision of a uid carry a SEQUENCE greater
 * than or equal to the one before it, and revisions happen in wall-clock order:
 * a booking is confirmed, then moved, then cancelled. So whole seconds since
 * the booking row was created is a counter we already have — no `sequence`
 * column, no migration. Two revisions inside the same second tie, and DTSTAMP
 * breaks the tie, which is what RFC 5546 tells a client to do.
 */
export function icsSequence(createdAt: Date, at: Date = new Date()): number {
  const from = createdAt?.getTime?.();
  const to = at?.getTime?.();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 1000));
}

export function buildIcs(input: IcsInput): string {
  const method: IcsMethod = input.method === 'CANCEL' ? 'CANCEL' : 'REQUEST';
  const stamp = input.stamp ?? new Date();
  const organizerName = input.organizerName ? icsParam(input.organizerName) : '';
  const attendeeName = input.attendeeName ? icsParam(input.attendeeName) : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kds-marketing//booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${icsEscape(input.uid)}`,
    `DTSTAMP:${icsDate(stamp)}`,
    `DTSTART:${icsDate(input.start)}`,
    `DTEND:${icsDate(input.end)}`,
    `SEQUENCE:${icsSequenceValue(input.sequence)}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${icsEscape(input.summary)}`,
    ...(input.description ? [`DESCRIPTION:${icsEscape(input.description)}`] : []),
    ...(input.joinUrl
      ? [
          `URL:${icsEscape(input.joinUrl)}`,
          `LOCATION:${icsEscape(input.joinUrl)}`,
          `X-GOOGLE-CONFERENCE:${icsEscape(input.joinUrl)}`,
        ]
      : []),
    ...(input.organizerEmail
      ? [
          `ORGANIZER${organizerName ? `;CN=${organizerName}` : ''}:mailto:${input.organizerEmail}`,
        ]
      : []),
    ...(input.attendeeEmail
      ? [
          `ATTENDEE${attendeeName ? `;CN=${attendeeName}` : ''};ROLE=REQ-PARTICIPANT;` +
            // A withdrawn appointment asks for no answer.
            `PARTSTAT=NEEDS-ACTION;RSVP=${method === 'CANCEL' ? 'FALSE' : 'TRUE'}:mailto:${input.attendeeEmail}`,
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // RFC-5545 requires CRLF line endings.
  return lines.map(fold).join('\r\n') + '\r\n';
}
