import { Navigate, useLocation } from 'react-router-dom';

/** Old bookmarks retain their detail/filter query and replace the obsolete history entry. */
export function LegacyRedirect({ to }: { to?: string }) {
  const { search } = useLocation();
  if (to) return <Navigate replace to={`${to}${search}`} />;
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  if (tab === 'materials') return <Navigate replace to={materialsTarget(search)} />;
  const path = tab === 'projects' ? '/content' : '/social';
  if (tab !== 'posts') params.delete('tab');
  return <Navigate replace to={`${path}${params.size ? `?${params}` : ''}`} />;
}

/**
 * Where an address of the former materials library lands on the content page (design
 * 2026-11-18): its olay (or Genel) stays the folder and its material the open file.
 */
export function materialsTarget(search: string): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  const olay = params.get('olay');
  const material = params.get('material');
  // `review` was a shelf, not an olay; the folder's files show what waits for a person.
  if (olay && olay !== 'review') out.set('olay', olay);
  if (material) out.set('file', material);
  return `/content${out.size ? `?${out}` : ''}`;
}

/** `/materials`: the library is part of the content page now. */
export function MaterialsRedirect() {
  const { search } = useLocation();
  return <Navigate replace to={materialsTarget(search)} />;
}
