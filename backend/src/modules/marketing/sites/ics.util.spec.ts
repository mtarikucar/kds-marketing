import { buildIcs } from './ics.util';

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
});
