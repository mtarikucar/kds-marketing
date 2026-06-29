/**
 * Defensive pagination input coercion.
 *
 * Query params arrive as strings, and some controllers `parseInt()` them — a
 * non-numeric `?page=abc` then becomes `NaN`. An unguarded `NaN` (or negative)
 * flowing into Prisma `skip`/`take` makes the driver throw, surfacing as a 500.
 * These helpers coerce the input to safe bounds so malformed paging degrades to
 * the first page / a default size instead of crashing.
 */

/** A safe 1-based page integer (NaN / non-numeric / <1 / fractional → 1). */
export function safePage(page: unknown): number {
  const n = Math.floor(Number(page));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** A safe page size in [1, max] (NaN / non-numeric / <1 → fallback). */
export function safeLimit(limit: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}
