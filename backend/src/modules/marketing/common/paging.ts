/**
 * Defensive pagination input coercion.
 *
 * Query params arrive as strings, and some controllers `parseInt()` them — a
 * non-numeric `?page=abc` then becomes `NaN`. An unguarded `NaN` (or negative)
 * flowing into Prisma `skip`/`take` makes the driver throw, surfacing as a 500.
 * These helpers coerce the input to safe bounds so malformed paging degrades to
 * the first page / a default size instead of crashing.
 */

/**
 * A page ceiling so `skip = (page-1) * limit` can't overflow Postgres int4
 * (2,147,483,647) and re-surface as a Prisma 500 — the exact crash this helper
 * exists to prevent. A million pages is far beyond any real dataset, and with the
 * separately-capped page size (safeLimit, ≤ a few hundred) keeps skip well inside
 * int4. Callers past this cap just get the last allowed page instead of a 500.
 */
const MAX_PAGE = 1_000_000;

/** A safe 1-based page integer (NaN / non-numeric / <1 / fractional → 1; capped
 *  at MAX_PAGE so a huge ?page can't overflow the int4 skip). */
export function safePage(page: unknown): number {
  const n = Math.floor(Number(page));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}

/** A safe page size in [1, max] (NaN / non-numeric / <1 → fallback). */
export function safeLimit(limit: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}
