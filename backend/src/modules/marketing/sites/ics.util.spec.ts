import { buildIcs, icsSequence } from './ics.util';

describe('buildIcs', () => {
  const base = {
    uid: 'b-1',
    start: new Date('2026-07-01T10:00:00.000Z'),
    end: new Date('2026-07-01T10:30:00.000Z'),
    summary: 'Sales call',
  };

  it('emits a well-formed VEVENT with UTC times and CRLF endings', () => {
    const ics = buildIcs(base);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:b-1');
    expect(ics).toContain('DTSTART:20260701T100000Z');
    expect(ics).toContain('DTEND:20260701T103000Z');
    expect(ics).toContain('SUMMARY:Sales call');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics.includes('\r\n')).toBe(true);
  });

  it('carries the join link as URL + LOCATION when provided', () => {
    const ics = buildIcs({ ...base, joinUrl: 'https://meet.google.com/abc' });
    expect(ics).toContain('URL:https://meet.google.com/abc');
    expect(ics).toContain('LOCATION:https://meet.google.com/abc');
    expect(ics).toContain('X-GOOGLE-CONFERENCE:https://meet.google.com/abc');
  });

  it('omits conferencing lines when there is no join link', () => {
    const ics = buildIcs(base);
    expect(ics).not.toContain('LOCATION:');
    expect(ics).not.toContain('X-GOOGLE-CONFERENCE:');
  });

  it('escapes commas and semicolons in text fields', () => {
    const ics = buildIcs({ ...base, summary: 'Call, with; notes' });
    expect(ics).toContain('SUMMARY:Call\\, with\\; notes');
  });

  // ── the invite is a REVISION of an appointment, not a snapshot ────────────

  it('stamps DTSTAMP with the moment the revision was produced, not the start', () => {
    // DTSTAMP:<start> made every revision of the same UID look equally old, so
    // a client with two copies could not tell which one was current.
    const ics = buildIcs({ ...base, stamp: new Date('2026-06-20T08:15:30.000Z') });
    expect(ics).toContain('DTSTAMP:20260620T081530Z');
    expect(ics).not.toContain('DTSTAMP:20260701T100000Z');
  });

  it('defaults to a REQUEST that CONFIRMS, and emits SEQUENCE:0', () => {
    const ics = buildIcs(base);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('SEQUENCE:0');
  });

  it('cancels with METHOD:CANCEL + STATUS:CANCELLED on the same UID', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', sequence: 4 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:4');
    expect(ics).toContain('UID:b-1');
    expect(ics).not.toContain('METHOD:REQUEST');
  });

  it('clamps a nonsense SEQUENCE to 0 rather than emitting an invalid line', () => {
    expect(buildIcs({ ...base, sequence: -3 })).toContain('SEQUENCE:0');
    expect(buildIcs({ ...base, sequence: 2.7 })).toContain('SEQUENCE:2');
    expect(buildIcs({ ...base, sequence: Number.NaN })).toContain('SEQUENCE:0');
  });

  it('names the ORGANIZER and the ATTENDEE so clients render an RSVP card', () => {
    const ics = buildIcs({
      ...base,
      organizerEmail: 'hello@acme.com',
      organizerName: 'Acme',
      attendeeEmail: 'ada@example.com',
      attendeeName: 'Ada Lovelace',
    });
    expect(ics).toContain('ORGANIZER;CN=Acme:mailto:hello@acme.com');
    // The ATTENDEE line is past 75 octets, so it arrives folded.
    expect(ics.replace(/\r\n /g, '')).toContain(
      'ATTENDEE;CN=Ada Lovelace;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ada@example.com',
    );
  });

  it('omits ORGANIZER and ATTENDEE when there is no address for them', () => {
    const ics = buildIcs(base);
    expect(ics).not.toContain('ORGANIZER');
    expect(ics).not.toContain('ATTENDEE');
  });

  it('does not ask a cancelled invite to RSVP', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', attendeeEmail: 'ada@example.com' });
    expect(ics).toContain('RSVP=FALSE');
    expect(ics).not.toContain('RSVP=TRUE');
  });

  it('folds a long line at 75 octets with a CRLF + space continuation', () => {
    // A DESCRIPTION carrying a manage link is well past the 75-octet limit, and
    // an unfolded content line is what makes a strict parser drop the property.
    const long = `x${'y'.repeat(200)}`;
    const ics = buildIcs({ ...base, description: long });
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop CRLF + one leading space) gives the value back intact.
    expect(ics.replace(/\r\n /g, '')).toContain(`DESCRIPTION:${long}`);
  });

  it('never splits a multi-byte character across a fold', () => {
    const ics = buildIcs({ ...base, summary: 'ş'.repeat(80) });
    for (const line of ics.split('\r\n')) {
      expect(line).not.toContain('�');
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${'ş'.repeat(80)}`);
  });
});

describe('icsSequence', () => {
  const created = new Date('2026-07-01T10:00:00.000Z');

  it('starts at 0 and rises with each later revision', () => {
    expect(icsSequence(created, created)).toBe(0);
    const first = icsSequence(created, new Date('2026-07-01T10:00:30.000Z'));
    const second = icsSequence(created, new Date('2026-07-02T10:00:00.000Z'));
    expect(first).toBe(30);
    expect(second).toBeGreaterThan(first);
  });

  it('never goes negative, whatever the clock says', () => {
    expect(icsSequence(created, new Date('2026-06-01T00:00:00.000Z'))).toBe(0);
    expect(icsSequence(new Date(Number.NaN), created)).toBe(0);
  });
});
