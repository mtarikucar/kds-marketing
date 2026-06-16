import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// ── Eager (layout / guard) imports ────────────────────────────────────────────
import { MarketingLayout, MarketingProtectedRoute } from './features/marketing/components';
import { MarketingRole } from './features/marketing/types';
import PlatformLayout from './features/platform/components/PlatformLayout';
import { useReferralCapture } from './features/marketing/hooks/useReferralCapture';

// ── Route fallback ─────────────────────────────────────────────────────────────
import { RouteFallback } from './components/RouteFallback';

// ── Lazy page imports — marketing realm ───────────────────────────────────────
const MarketingLoginPage       = lazy(() => import('./pages/marketing/MarketingLoginPage'));
const RegisterWorkspacePage    = lazy(() => import('./pages/marketing/RegisterWorkspacePage'));
const WidgetChatPage           = lazy(() => import('./pages/marketing/WidgetChatPage'));
const MarketingDashboardPage   = lazy(() => import('./pages/marketing/MarketingDashboardPage'));
const InboxPage                = lazy(() => import('./pages/marketing/inbox/InboxPage'));
const LeadsPage                = lazy(() => import('./pages/marketing/leads/LeadsPage'));
const CreateLeadPage           = lazy(() => import('./pages/marketing/CreateLeadPage'));
const LeadDetailPage           = lazy(() => import('./pages/marketing/leadDetail/LeadDetailPage'));
const TasksPage                = lazy(() => import('./pages/marketing/tasks/TasksPage'));
const CalendarPage             = lazy(() => import('./pages/marketing/calendar/CalendarPage'));
const OffersPage               = lazy(() => import('./pages/marketing/offers/OffersPage'));
const ReportsPage              = lazy(() => import('./pages/marketing/ReportsPage'));
const CommissionsPage          = lazy(() => import('./pages/marketing/CommissionsPage'));
const InstallationsPage        = lazy(() => import('./pages/marketing/installations/InstallationsPage'));
const CallsPage                = lazy(() => import('./pages/marketing/CallsPage'));
const PerformancePage          = lazy(() => import('./pages/marketing/PerformancePage'));
const BillingPage              = lazy(() => import('./pages/marketing/billing'));
// Manager-only pages
const MarketingUsersPage       = lazy(() => import('./pages/marketing/users'));
const TargetsPage              = lazy(() => import('./pages/marketing/targets'));
const CustomFieldsPage         = lazy(() => import('./pages/marketing/crm/customFields'));
const TagsPage                 = lazy(() => import('./pages/marketing/crm/tags'));
const SegmentsPage             = lazy(() => import('./pages/marketing/crm/segments'));
const ResearchSettingsPage     = lazy(() => import('./pages/marketing/research/ResearchSettingsPage'));
const AgentStudioPage          = lazy(() => import('./pages/marketing/AgentStudioPage'));
const KnowledgeBasePage        = lazy(() => import('./pages/marketing/KnowledgeBasePage'));
const ChannelsSettingsPage     = lazy(() => import('./pages/marketing/ChannelsSettingsPage'));
const AutomationsPage          = lazy(() => import('./pages/marketing/AutomationsPage'));
const CampaignsPage            = lazy(() => import('./pages/marketing/CampaignsPage'));
const SitesPage                = lazy(() => import('./pages/marketing/SitesPage'));
const BookingSettingsPage      = lazy(() => import('./pages/marketing/BookingSettingsPage'));
const ReviewsPage              = lazy(() => import('./pages/marketing/ReviewsPage'));
const VoicePage                = lazy(() => import('./pages/marketing/VoicePage'));
const InvoicesPage             = lazy(() => import('./pages/marketing/invoices'));
const BrandingSettingsPage     = lazy(() => import('./pages/marketing/BrandingSettingsPage'));

// ── Lazy page imports — platform (superadmin) realm ───────────────────────────
const PlatformLoginPage          = lazy(() => import('./pages/platform/PlatformLoginPage'));
const PlatformWorkspacesPage     = lazy(() => import('./pages/platform/PlatformWorkspacesPage'));
const PlatformWorkspaceDetailPage = lazy(() => import('./pages/platform/PlatformWorkspaceDetailPage'));
const ManualPaymentsPage         = lazy(() => import('./pages/platform/ManualPaymentsPage'));
const PlatformRoutinesPage       = lazy(() => import('./pages/platform/routines/PlatformRoutinesPage'));

// ── Dev-only lazy page ────────────────────────────────────────────────────────
const UiKitchenSinkPage = lazy(() => import('./pages/_dev/UiKitchenSinkPage'));

// Helper: wrap a lazy page in a Suspense boundary with the shared fallback.
function S({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

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
      <Route path="/login"    element={<S><MarketingLoginPage /></S>} />
      <Route path="/register" element={<S><RegisterWorkspacePage /></S>} />
      {/* Public web-chat surface — embedded in an iframe by widget.js. */}
      <Route path="/widget"   element={<S><WidgetChatPage /></S>} />

      {/* Platform (superadmin) realm — separate auth store + token. The login
          page sits OUTSIDE the layout; PlatformLayout carries the realm auth
          guard (redirects to /platform/login when unauthenticated) + shell. */}
      <Route path="/platform/login" element={<S><PlatformLoginPage /></S>} />
      <Route element={<PlatformLayout />}>
        <Route path="/platform/workspaces"    element={<S><PlatformWorkspacesPage /></S>} />
        <Route path="/platform/workspaces/:id" element={<S><PlatformWorkspaceDetailPage /></S>} />
        <Route path="/platform/payments"      element={<S><ManualPaymentsPage /></S>} />
        <Route path="/platform/routines"      element={<S><PlatformRoutinesPage /></S>} />
      </Route>

      {/* Marketing realm — guarded by MarketingProtectedRoute (auth check). */}
      <Route element={<MarketingProtectedRoute />}>
        <Route element={<MarketingLayout />}>
          <Route path="/"          element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<S><MarketingDashboardPage /></S>} />
          <Route path="/inbox"     element={<S><InboxPage /></S>} />
          <Route path="/leads"     element={<S><LeadsPage /></S>} />
          <Route path="/leads/new" element={<S><CreateLeadPage /></S>} />
          <Route path="/leads/:id" element={<S><LeadDetailPage /></S>} />
          <Route path="/leads/:id/edit" element={<S><CreateLeadPage /></S>} />
          <Route path="/tasks"          element={<S><TasksPage /></S>} />
          <Route path="/calendar"       element={<S><CalendarPage /></S>} />
          <Route path="/offers"         element={<S><OffersPage /></S>} />
          <Route path="/reports"        element={<S><ReportsPage /></S>} />
          <Route path="/commissions"    element={<S><CommissionsPage /></S>} />
          <Route path="/installations"  element={<S><InstallationsPage /></S>} />
          <Route path="/calls"          element={<S><CallsPage /></S>} />
          <Route path="/performance"    element={<S><PerformancePage /></S>} />
          <Route path="/billing"        element={<S><BillingPage /></S>} />
        </Route>
        <Route element={<MarketingProtectedRoute requiredRole={MarketingRole.MANAGER} />}>
          <Route element={<MarketingLayout />}>
            <Route path="/users"       element={<S><MarketingUsersPage /></S>} />
            <Route path="/targets"     element={<S><TargetsPage /></S>} />
            <Route path="/settings/custom-fields" element={<S><CustomFieldsPage /></S>} />
            <Route path="/settings/tags"          element={<S><TagsPage /></S>} />
            <Route path="/settings/segments"      element={<S><SegmentsPage /></S>} />
            <Route path="/research"    element={<S><ResearchSettingsPage /></S>} />
            <Route path="/ai/agents"   element={<S><AgentStudioPage /></S>} />
            <Route path="/ai/knowledge" element={<S><KnowledgeBasePage /></S>} />
            <Route path="/channels"    element={<S><ChannelsSettingsPage /></S>} />
            <Route path="/automations" element={<S><AutomationsPage /></S>} />
            <Route path="/campaigns"   element={<S><CampaignsPage /></S>} />
            <Route path="/sites"       element={<S><SitesPage /></S>} />
            <Route path="/booking"     element={<S><BookingSettingsPage /></S>} />
            <Route path="/reviews"     element={<S><ReviewsPage /></S>} />
            <Route path="/voice"       element={<S><VoicePage /></S>} />
            <Route path="/invoices"    element={<S><InvoicesPage /></S>} />
            <Route path="/branding"    element={<S><BrandingSettingsPage /></S>} />
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
