import { Navigate, useLocation } from 'react-router-dom';
import { legacyTarget } from '@/pages/posts/location';

/**
 * Old bookmarks retain their detail/filter query and replace the obsolete history entry. `page`:
 * one of the pages Paylaşımlar replaced (design 2026-11-19 §2.11), whose query is mapped to the
 * new page's address; else `to` with the query as it is.
 */
export function LegacyRedirect({ to = '/', page }: { to?: string; page?: 'content' | 'social' | 'studio' | 'materials' }) {
  const { search, hash } = useLocation();
  if (page) return <Navigate replace to={legacyTarget(page, search, hash)} />;
  return <Navigate replace to={`${to}${search}`} />;
}
