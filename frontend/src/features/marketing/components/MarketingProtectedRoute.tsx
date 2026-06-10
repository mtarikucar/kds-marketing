import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import type { MarketingRole } from '../types';

interface MarketingProtectedRouteProps {
  /**
   * If supplied, the route is gated on the user's role in addition to
   * authentication. A SALES_REP visiting a `requiredRole='SALES_MANAGER'`
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
    return <Navigate to="/login" replace />;
  }

  if (requiredRole && user?.role !== requiredRole) {
    // Role mismatch — send back to the dashboard rather than show a
    // bare 403 from the API. SALES_REP trying to reach manager-only
    // routes (users, performance reports, commission approvals) lands
    // here.
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
