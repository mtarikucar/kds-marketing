/**
 * Inclusive upper bound for a report/analytics date range.
 *
 * The frontend sends a bare date string (`YYYY-MM-DD`) for the range end.
 * `new Date('2026-06-25')` parses to `2026-06-25T00:00:00.000Z` (UTC midnight),
 * so a Prisma `lte` of that value excludes everything created DURING the
 * selected end day — the whole final day silently drops out of every report.
 * Bumping a bare date to end-of-day makes the end date inclusive. A value that
 * already carries a time component is returned unchanged.
 */
export function rangeEndInclusive(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T23:59:59.999Z`)
    : new Date(value);
}
