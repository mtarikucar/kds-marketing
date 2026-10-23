/** Where to go after signing in: the page that asked for it (router state), else `fallback`. */
export function returnTarget(state: unknown, fallback: string): string {
  const from = (state as { from?: unknown } | null)?.from;
  // Only paths inside the panel: never another origin or a protocol-relative URL.
  if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  return fallback;
}
