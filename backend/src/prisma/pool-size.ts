import { availableParallelism } from "os";

/**
 * How many connections Prisma opens for `url`.
 *
 * Prisma takes `connection_limit` from the datasource URL and, without one,
 * opens `num_physical_cpus * 2 + 1`. Node only sees LOGICAL CPUs, so on a host
 * with SMT the default computed here can over-count the real pool, never
 * under-count it — callers that size against it must leave room for that.
 */
export function poolSizeFor(url: string | undefined): number {
  try {
    const raw = url ? new URL(url).searchParams.get("connection_limit") : null;
    if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  } catch {
    // Not a URL Node can parse; fall through to Prisma's default.
  }
  return availableParallelism() * 2 + 1;
}
