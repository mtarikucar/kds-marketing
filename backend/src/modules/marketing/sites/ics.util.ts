/**
 * Minimal, dependency-free RFC-5545 VEVENT builder for booking confirmations.
 * Times are emitted as UTC (`YYYYMMDDTHHMMSSZ`). When a `joinUrl` is given the
 * event carries it as URL + LOCATION + X-GOOGLE-CONFERENCE so calendar clients
 * render a one-click join. Text is escaped per the spec (`\ ; , \n`).
 */
export interface IcsInput {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  joinUrl?: string;
  organizerEmail?: string;
}

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

export function buildIcs(input: IcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kds-marketing//booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${icsEscape(input.uid)}`,
    `DTSTAMP:${icsDate(input.start)}`,
    `DTSTART:${icsDate(input.start)}`,
    `DTEND:${icsDate(input.end)}`,
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
      ? [`ORGANIZER:mailto:${input.organizerEmail}`]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // RFC-5545 requires CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}
