import { useRef } from 'react';

// Small helpers the leads pages share (spec 2026-10-30-leads-pool-outreach-design.md §9).

/**
 * One request key per draft: the same key while the draft is unchanged (a retry after a lost
 * answer replays instead of doing it twice), a new one as soon as it changes.
 */
export function useDraftKey() {
  const current = useRef<{ draft: string; key: string }>();
  return {
    keyFor(draft: unknown): string {
      const text = JSON.stringify(draft);
      if (current.current?.draft !== text) current.current = { draft: text, key: crypto.randomUUID() };
      return current.current.key;
    },
    reset() {
      current.current = undefined;
    },
  };
}

/**
 * A submit guard that holds on Enter too (bug class "Enter double-submit"): a ref, since a second
 * submit in the same tick sees `isPending` not yet set. `run` starts the work and hands it the
 * function that releases the guard once it settles.
 */
export function useInFlight() {
  const busy = useRef(false);
  return (start: (release: () => void) => void): void => {
    if (busy.current) return;
    busy.current = true;
    start(() => {
      busy.current = false;
    });
  };
}

/** `url` when the panel may link to it: an absolute `http(s)` address; else `null`. */
export function webUrl(url: string): string | null {
  try {
    const address = new URL(url);
    return address.protocol === 'https:' || address.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** The non-empty, trimmed lines of a text area. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Areas written one a line as `city` or `city / district`. */
export function areaLines(text: string): { city: string; district: string | null }[] {
  return lines(text).map((l) => {
    const [city, ...rest] = l.split('/');
    const district = rest.join('/').trim();
    return { city: city.trim(), district: district || null };
  });
}
