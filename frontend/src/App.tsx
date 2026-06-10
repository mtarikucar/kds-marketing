import { Routes, Route, Navigate } from 'react-router-dom';
import { MarketingLayout, MarketingProtectedRoute } from './features/marketing/components';
import { MarketingRole } from './features/marketing/types';
import MarketingLoginPage from './pages/marketing/MarketingLoginPage';
import MarketingDashboardPage from './pages/marketing/MarketingDashboardPage';
import LeadsPage from './pages/marketing/LeadsPage';
import CreateLeadPage from './pages/marketing/CreateLeadPage';
import LeadDetailPage from './pages/marketing/LeadDetailPage';
import TasksPage from './pages/marketing/TasksPage';
import CalendarPage from './pages/marketing/CalendarPage';
import OffersPage from './pages/marketing/OffersPage';
import ReportsPage from './pages/marketing/ReportsPage';
import CommissionsPage from './pages/marketing/CommissionsPage';
import MarketingUsersPage from './pages/marketing/MarketingUsersPage';
import InstallationsPage from './pages/marketing/InstallationsPage';
import CallsPage from './pages/marketing/CallsPage';
import PerformancePage from './pages/marketing/PerformancePage';
import TargetsPage from './pages/marketing/TargetsPage';

/**
 * Standalone marketing console at the ROOT of marketing.hummytummy.com. This is
 * the sole home of the marketing panel now — the POS app no longer embeds it
 * (its /marketing routes were removed; nginx 301-redirects /marketing/* here).
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<MarketingLoginPage />} />
      <Route element={<MarketingProtectedRoute />}>
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<MarketingDashboardPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/new" element={<CreateLeadPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/leads/:id/edit" element={<CreateLeadPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/offers" element={<OffersPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/commissions" element={<CommissionsPage />} />
          <Route path="/installations" element={<InstallationsPage />} />
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/performance" element={<PerformancePage />} />
        </Route>
        <Route element={<MarketingProtectedRoute requiredRole={MarketingRole.SALES_MANAGER} />}>
          <Route element={<MarketingLayout />}>
            <Route path="/users" element={<MarketingUsersPage />} />
            <Route path="/targets" element={<TargetsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
