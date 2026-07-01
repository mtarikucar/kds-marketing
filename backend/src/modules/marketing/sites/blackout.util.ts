/**
 * Blackout / time-off overlap logic (Phase 2). A blackout window with
 * `marketingUserId === null` applies to everyone (calendar/workspace closure); a
 * member-scoped one only blocks that specific assignee. Pure + dependency-free
 * so both availability() and book() share the exact same rule.
 */
export interface BlackoutWindow {
  startAt: Date;
  endAt: Date;
  marketingUserId: string | null;
}

/**
 * True when the slot [startMs, endMs) overlaps a blackout that applies to
 * `assigneeUserId`. Null-scoped windows apply to everyone; member-scoped windows
 * apply only when they match `assigneeUserId`.
 */
export function overlapsBlackout(
  blackouts: BlackoutWindow[],
  startMs: number,
  endMs: number,
  assigneeUserId: string | null,
): boolean {
  for (const b of blackouts) {
    const bs = b.startAt.getTime();
    const be = b.endAt.getTime();
    if (!(startMs < be && endMs > bs)) continue; // no time overlap
    if (b.marketingUserId == null) return true; // applies to everyone
    if (assigneeUserId && b.marketingUserId === assigneeUserId) return true;
  }
  return false;
}
