import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Honors the `?create=1` deep-link convention used by the global "+ Create"
 * menu and the command palette: when the param is present, invoke `open()` once
 * to pop the page's create modal, then strip the param so a refresh/back button
 * doesn't re-open it. Fires at most once per appearance of the param (guarded by
 * a ref), regardless of `open`'s identity changing between renders.
 */
export function useCreateParam(open: () => void) {
  const [searchParams, setSearchParams] = useSearchParams();
  const firedRef = useRef(false);
  const shouldOpen = searchParams.get('create') === '1';

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
