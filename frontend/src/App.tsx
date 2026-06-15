import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

const UiKitchenSinkPage = lazy(
  () => import('./pages/_dev/UiKitchenSinkPage'),
);
import { MarketingLayout, MarketingProtectedRoute } from './features/marketing/components';
import { MarketingRole } from './features/marketing/types';
import MarketingLoginPage from './pages/marketing/MarketingLoginPage';
import MarketingDashboardPage from './pages/marketing/MarketingDashboardPage';
import LeadsPage from './pages/marketing/leads/LeadsPage';
import CreateLeadPage from './pages/marketing/CreateLeadPage';
import LeadDetailPage from './pages/marketing/leadDetail/LeadDetailPage';
import TasksPage from './pages/marketing/tasks/TasksPage';
import CalendarPage from './pages/marketing/calendar/CalendarPage';
import OffersPage from './pages/marketing/offers/OffersPage';
import ReportsPage from './pages/marketing/ReportsPage';
import CommissionsPage from './pages/marketing/CommissionsPage';
import MarketingUsersPage from './pages/marketing/users';
import InstallationsPage from './pages/marketing/installations/InstallationsPage';
import CallsPage from './pages/marketing/CallsPage';
import PerformancePage from './pages/marketing/PerformancePage';
import TargetsPage from './pages/marketing/targets';
import RegisterWorkspacePage from './pages/marketing/RegisterWorkspacePage';
import ResearchSettingsPage from './pages/marketing/ResearchSettingsPage';
import AgentStudioPage from './pages/marketing/AgentStudioPage';
import KnowledgeBasePage from './pages/marketing/KnowledgeBasePage';
import InboxPage from './pages/marketing/InboxPage';
import ChannelsSettingsPage from './pages/marketing/ChannelsSettingsPage';
import AutomationsPage from './pages/marketing/AutomationsPage';
import CampaignsPage from './pages/marketing/CampaignsPage';
import SitesPage from './pages/marketing/SitesPage';
import BookingSettingsPage from './pages/marketing/BookingSettingsPage';
import ReviewsPage from './pages/marketing/ReviewsPage';
import VoicePage from './pages/marketing/VoicePage';
import InvoicesPage from './pages/marketing/InvoicesPage';
import BrandingSettingsPage from './pages/marketing/BrandingSettingsPage';
import WidgetChatPage from './pages/marketing/WidgetChatPage';
import BillingPage from './pages/marketing/BillingPage';
import ManualPaymentsPage from './pages/platform/ManualPaymentsPage';
import PlatformLoginPage from './pages/platform/PlatformLoginPage';
import PlatformWorkspacesPage from './pages/platform/PlatformWorkspacesPage';
import PlatformWorkspaceDetailPage from './pages/platform/PlatformWorkspaceDetailPage';
import PlatformRoutinesPage from './pages/platform/PlatformRoutinesPage';
import { useReferralCapture } from './features/marketing/hooks/useReferralCapture';

/**
 * Standalone marketing console served at the ROOT of its own (sub)domain. This is
 * the sole home of the marketing panel now — the POS app no longer embeds it
 * (its /marketing routes were removed; nginx 301-redirects /marketing/* here).
 */
export default function App() {
  // Capture `?ref=CODE` into a 30-day cookie once, regardless of landing route.
  // NOTE: cookie CONSUMPTION on register/checkout (reading the cookie back and
  // attaching the code to the create-workspace / order payload) is a separate
  // backend-contract task — not wired here.
  useReferralCapture();

  return (
    <Routes>
      <Route path="/login" element={<MarketingLoginPage />} />
      <Route path="/register" element={<RegisterWorkspacePage />} />
      {/* Public web-chat surface — embedded in an iframe by widget.js. */}
      <Route path="/widget" element={<WidgetChatPage />} />
      {/* Platform (superadmin) realm — separate auth store + token. */}
      <Route path="/platform/login" element={<PlatformLoginPage />} />
      <Route path="/platform/workspaces" element={<PlatformWorkspacesPage />} />
      <Route path="/platform/workspaces/:id" element={<PlatformWorkspaceDetailPage />} />
      <Route path="/platform/payments" element={<ManualPaymentsPage />} />
      <Route path="/platform/routines" element={<PlatformRoutinesPage />} />
      <Route element={<MarketingProtectedRoute />}>
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<MarketingDashboardPage />} />
          <Route path="/inbox" element={<InboxPage />} />
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
          <Route path="/billing" element={<BillingPage />} />
        </Route>
        <Route element={<MarketingProtectedRoute requiredRole={MarketingRole.MANAGER} />}>
          <Route element={<MarketingLayout />}>
            <Route path="/users" element={<MarketingUsersPage />} />
            <Route path="/targets" element={<TargetsPage />} />
            <Route path="/research" element={<ResearchSettingsPage />} />
            <Route path="/ai/agents" element={<AgentStudioPage />} />
            <Route path="/ai/knowledge" element={<KnowledgeBasePage />} />
            <Route path="/channels" element={<ChannelsSettingsPage />} />
            <Route path="/automations" element={<AutomationsPage />} />
            <Route path="/campaigns" element={<CampaignsPage />} />
            <Route path="/sites" element={<SitesPage />} />
            <Route path="/booking" element={<BookingSettingsPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/voice" element={<VoicePage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/branding" element={<BrandingSettingsPage />} />
          </Route>
        </Route>
      </Route>
      {import.meta.env.DEV && (
        <Route
          path="/_dev/ui"
          element={
            <Suspense fallback={null}>
              <UiKitchenSinkPage />
            </Suspense>
          }
        />
      )}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
