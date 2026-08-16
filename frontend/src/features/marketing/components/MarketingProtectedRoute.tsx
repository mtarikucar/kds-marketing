import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { hasMarketingRole, type MarketingRole } from '../types';

interface MarketingProtectedRouteProps {
  /**
   * If supplied, the route is gated on the user's role in addition to
   * authentication. A REP visiting a `requiredRole='MANAGER'`
   * route is redirected to the dashboard instead of getting a backend
   * 403 with no UX recovery — the backend still enforces the same
   * rule, this is just the visible gate.
   */
  requiredRole?: MarketingRole;
}

export default function MarketingProtectedRoute({
  requiredRole,
}: MarketingProtectedRouteProps = {}) {
  const { isAuthenticated, accessToken, user, logout } = useMarketingAuthStore();
  const location = useLocation();

  useEffect(() => {
    if (accessToken) {
      try {
        const payload = JSON.parse(atob(accessToken.split('.')[1]));
        if (payload.exp * 1000 < Date.now()) {
          logout();
        }
      } catch {
        logout();
      }
    }
  }, [accessToken, logout]);

  if (!isAuthenticated) {
    // Carry the attempted location so login can hand the user back to it.
    // Deep links matter everywhere, but the MCP OAuth consent screen makes it
    // load-bearing: the authorization request lives ENTIRELY in that query
    // string, so dropping it turns "sign in to approve Claude" into a dead end
    // the user cannot recover from without restarting the flow in the client.
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  if (requiredRole && !hasMarketingRole(user?.role, requiredRole)) {
    // Role mismatch — send back to the dashboard rather than show a
    // bare 403 from the API. REP trying to reach manager-only
    // routes (users, performance reports, commission approvals) lands
    // here.
    return <Navigate to="/home" replace />;
  }

  return <Outlet />;
}
