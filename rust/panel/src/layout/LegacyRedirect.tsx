import { Navigate, useLocation } from 'react-router-dom';

/** Old bookmarks retain their detail/filter query and replace the obsolete history entry. */
export function LegacyRedirect({ to }: { to?: string }) {
  const { search } = useLocation();
  if (to) return <Navigate replace to={`${to}${search}`} />;
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const path = tab === 'materials' ? '/materials' : tab === 'projects' ? '/content' : '/social';
  if (tab !== 'posts') params.delete('tab');
  return <Navigate replace to={`${path}${params.size ? `?${params}` : ''}`} />;
}
