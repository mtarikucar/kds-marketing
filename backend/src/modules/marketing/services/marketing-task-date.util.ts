import { BadRequestException } from '@nestjs/common';

/**
 * Parse a task `dueDate` (date-only `YYYY-MM-DD`, full ISO datetime, or a Date)
 * into a `Date`. A date-only value is interpreted as the END of that day, not
 * UTC midnight — otherwise a task due "today", created in the afternoon by a
 * UTC+ user (e.g. UTC+3 / Turkey), would parse as hours in the past. Full
 * datetimes are used as-is.
 *
 * Past dates are ALLOWED — back-dating a task (e.g. logging a call that already
 * happened) is a legitimate workflow. The only failure is an unparseable value.
 */
export function parseDueDate(dueDate: Date | string): Date {
  const d =
    typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim())
      ? new Date(`${dueDate.trim()}T23:59:59.999Z`)
      : new Date(dueDate);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Invalid dueDate');
  }
  return d;
}
