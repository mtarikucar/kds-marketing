/**
 * Workspace-local wall-clock parts, for crons that must fire "at 05:00 for the
 * customer" rather than "at 05:00 wherever the box lives".
 *
 * Factored out of DailyDigestCron (which still exposes it as a static, and
 * still delegates here) because a SECOND scheduled lane now needs the same
 * answer, and this codebase has a documented bug class for exactly the shape a
 * copy would take: a date boundary computed from server-local time. Prod
 * containers run UTC, the customers run UTC+3, and every row created between
 * 00:00 and 03:00 Istanbul lands in the previous UTC day. One implementation,
 * one place to be wrong.
 */
export interface WorkspaceLocalParts {
  /** Local hour, 0-23. */
  hour: number;
  /** Local calendar date as `YYYY-MM-DD` — the natural per-day idempotency key. */
  date: string;
}

export function workspaceLocalParts(timezone: string, now = new Date()): WorkspaceLocalParts {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    return {
      // 24:00 is a legal formatToParts output for midnight in some locales.
      hour: Number(parts.hour) % 24,
      date: `${parts.year}-${parts.month}-${parts.day}`,
    };
  } catch {
    // An unknown/typo'd timezone must not silence a workspace forever.
    const iso = now.toISOString();
    return { hour: now.getUTCHours(), date: iso.slice(0, 10) };
  }
}
