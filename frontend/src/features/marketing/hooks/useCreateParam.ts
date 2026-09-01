import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Honors the `?create=1` deep-link convention used by the global "+ Create"
 * menu and the command palette: when the param is present, invoke `open()` once
 * to pop the page's create modal, then strip the param so a refresh/back button
 * doesn't re-open it. Fires at most once per appearance of the param (guarded by
 * a ref), regardless of `open`'s identity changing between renders.
 *
 * `enabled` exists for EMBEDDED pages. A page rendered inside another page's
 * surface is a column on somebody else's URL: `?create=1` there belongs to the
 * host, two embeddable views cannot both claim it, and consuming it also STRIPS
 * it — so an embedded reader would silently eat a parameter meant for the page
 * around it. Pass `!embedded`; the standalone route keeps the deep link.
 */
export function useCreateParam(open: () => void, enabled = true) {
  const [searchParams, setSearchParams] = useSearchParams();
  const firedRef = useRef(false);
  const shouldOpen = enabled && searchParams.get('create') === '1';

  useEffect(() => {
    if (shouldOpen && !firedRef.current) {
      firedRef.current = true;
      open();
      const next = new URLSearchParams(searchParams);
      next.delete('create');
      setSearchParams(next, { replace: true });
    }
    if (!shouldOpen) firedRef.current = false;
    // Intentionally keyed only on the param transition; `open` is read fresh and
    // the ref guard prevents duplicate fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldOpen]);
}
