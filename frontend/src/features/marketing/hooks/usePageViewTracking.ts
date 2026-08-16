import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import marketingApi from '../api/marketingApi';

/**
 * Counts which screens actually get opened.
 *
 * The 2026-08 rail cut moved ~10 destinations out of the sidebar on an argument
 * about what daily work looks like. Deleting them outright needs evidence, and
 * this is how that evidence gets collected.
 *
 * Three things it deliberately does NOT do:
 *
 *  - It never sends the query string. That is where any PII would be
 *    (`/leads?email=…`), and it answers nothing about which screen was opened.
 *  - It sends the raw pathname rather than a route pattern. `useMatches` would
 *    give the pattern, but it only works under a data router and this app uses
 *    the component router — calling it would throw. The server collapses
 *    id-shaped segments to `:id` instead, which it has to do regardless: the
 *    browser is not a trustworthy place to enforce that.
 *  - It never sends the same path twice in one session. The question is "does
 *    anyone open this screen", not "how many times did someone refresh".
 *
 * Failures are swallowed — a counter must never disturb a navigation, and a
 * lost tick costs nothing.
 */
export function usePageViewTracking(): void {
  const { pathname } = useLocation();
  const sent = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!pathname || sent.current.has(pathname)) return;
    sent.current.add(pathname);

    marketingApi.post('/page-views', { route: pathname }).catch(() => {
      // Not worth a console error on every offline navigation.
    });
  }, [pathname]);
}
