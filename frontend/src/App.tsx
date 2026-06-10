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
import WidgetChatPage from './pages/marketing/WidgetChatPage';
import BillingPage from './pages/marketing/BillingPage';
import ManualPaymentsPage from './pages/platform/ManualPaymentsPage';
import PlatformLoginPage from './pages/platform/PlatformLoginPage';
import PlatformWorkspacesPage from './pages/platform/PlatformWorkspacesPage';
import PlatformWorkspaceDetailPage from './pages/platform/PlatformWorkspaceDetailPage';

/**
 * Standalone marketing console served at the ROOT of its own (sub)domain. This is
 * the sole home of the marketing panel now — the POS app no longer embeds it
 * (its /marketing routes were removed; nginx 301-redirects /marketing/* here).
 */
export default function App() {
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
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
