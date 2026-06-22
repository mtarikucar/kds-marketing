import { BadRequestException } from '@nestjs/common';
import { parseDueDate } from './marketing-task-date.util';

describe('parseDueDate', () => {
  it('parses a date-only string as end-of-day UTC (back-compat)', () => {
    const d = parseDueDate('2030-01-15');
    expect(d.toISOString()).toBe('2030-01-15T23:59:59.999Z');
  });

  it('parses a full ISO datetime as the exact instant', () => {
    const d = parseDueDate('2030-01-15T14:30:00.000Z');
    expect(d.toISOString()).toBe('2030-01-15T14:30:00.000Z');
  });

  it('accepts a Date and returns an equivalent Date', () => {
    const input = new Date('2030-01-15T08:00:00.000Z');
    expect(parseDueDate(input).toISOString()).toBe('2030-01-15T08:00:00.000Z');
  });

  it('allows a past date (no rejection)', () => {
    // The whole point of this change: past dates must NOT throw.
    expect(() => parseDueDate('2000-01-01')).not.toThrow();
    expect(parseDueDate('2000-01-01').toISOString()).toBe('2000-01-01T23:59:59.999Z');
  });

  it('throws BadRequestException on an unparseable value', () => {
    expect(() => parseDueDate('not-a-date')).toThrow(BadRequestException);
  });

  it('trims surrounding whitespace on a date-only string', () => {
    expect(parseDueDate('  2030-01-15  ').toISOString()).toBe('2030-01-15T23:59:59.999Z');
  });
});
