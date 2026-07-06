import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';

// ── Eager (layout / guard) imports ────────────────────────────────────────────
import { MarketingLayout, MarketingProtectedRoute } from './features/marketing/components';
import { MarketingRole } from './features/marketing/types';
import PlatformLayout from './features/platform/components/PlatformLayout';
import { useReferralCapture } from './features/marketing/hooks/useReferralCapture';
import { useMarketingAuthStore } from './store/marketingAuthStore';

// ── Route fallback ─────────────────────────────────────────────────────────────
import { RouteFallback } from './components/RouteFallback';

// ── Lazy page imports — marketing realm ───────────────────────────────────────
const LandingPage              = lazy(() => import('./pages/landing/LandingPage'));
const PrivacyPage              = lazy(() => import('./pages/legal/PrivacyPage'));
const TermsPage                = lazy(() => import('./pages/legal/TermsPage'));
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
const OpportunitiesPage        = lazy(() => import('./pages/marketing/opportunities/OpportunitiesPage'));
const PipelineSettingsPage     = lazy(() => import('./pages/marketing/opportunities/PipelineSettingsPage'));
// Offers + Estimates + Documents are TABS of the Documents hub now.
const DocumentsHubPage         = lazy(() => import('./pages/marketing/documents/DocumentsHubPage'));
// Ads / Performance / Analytics are TABS inside ReportsPage now.
const ReportsPage              = lazy(() => import('./pages/marketing/ReportsPage'));
const GrowthStudioPage         = lazy(() => import('./pages/marketing/studio/GrowthStudioPage'));
const HelpPage                 = lazy(() => import('./pages/marketing/help'));
const CompaniesPage            = lazy(() => import('./pages/marketing/companies'));
const EmailTemplatesPage       = lazy(() => import('./pages/marketing/emailTemplates'));
const CommissionsPage          = lazy(() => import('./pages/marketing/CommissionsPage'));
const InstallationsPage        = lazy(() => import('./pages/marketing/installations/InstallationsPage'));
// The Power Dialer is a TAB inside CallsPage now.
const CallsPage                = lazy(() => import('./pages/marketing/CallsPage'));
const ProspectingPage          = lazy(() => import('./pages/marketing/ProspectingPage'));
const BillingPage              = lazy(() => import('./pages/marketing/billing'));
// Manager-only pages
const MarketingUsersPage       = lazy(() => import('./pages/marketing/users'));
const TargetsPage              = lazy(() => import('./pages/marketing/targets'));
const AccountCenterPage        = lazy(() => import('./pages/marketing/accounts/AccountCenterPage'));
const CustomFieldsPage         = lazy(() => import('./pages/marketing/crm/customFields'));
const TagsPage                 = lazy(() => import('./pages/marketing/crm/tags'));
const SegmentsPage             = lazy(() => import('./pages/marketing/crm/segments'));
const CoursesPage              = lazy(() => import('./pages/marketing/memberships/courses'));
const CourseEditorPage         = lazy(() => import('./pages/marketing/memberships/courses/CourseEditorPage'));
const AffiliatePortalPage      = lazy(() => import('./pages/marketing/affiliate-portal/AffiliatePortalPage'));
const AgencyLocationsPage      = lazy(() => import('./pages/marketing/agency/LocationsPage'));
const AgencySnapshotsPage      = lazy(() => import('./pages/marketing/agency/SnapshotsPage'));
const AgencyRebillingPage      = lazy(() => import('./pages/marketing/agency/RebillingPage'));
const ResearchSettingsPage     = lazy(() => import('./pages/marketing/research/ResearchSettingsPage'));
const ResearchSuggestionsPage  = lazy(() => import('./pages/marketing/research/ResearchSuggestionsPage'));
// Channels / Canned Responses / AI Agents / Knowledge are TABS of /inbox now.
const SendingDomainsPage       = lazy(() => import('./pages/marketing/settings/SendingDomainsPage'));
const CustomDomainsPage        = lazy(() => import('./pages/marketing/settings/CustomDomainsPage'));
const TriggerLinksPage         = lazy(() => import('./pages/marketing/triggerLinks'));
// Tax Rates + Coupons are TABS of /products now.
const AutomationsPage          = lazy(() => import('./pages/marketing/AutomationsPage'));
const AutomationBuilderPage    = lazy(() => import('./pages/marketing/automations/AutomationBuilderPage'));
const SitesPage                = lazy(() => import('./pages/marketing/SitesPage'));
const BookingSettingsPage      = lazy(() => import('./pages/marketing/BookingSettingsPage'));
const AppointmentsPage         = lazy(() => import('./pages/marketing/appointments/AppointmentsPage'));
const PublicBookingPage        = lazy(() => import('./pages/marketing/appointments/PublicBookingPage'));
const ReviewsPage              = lazy(() => import('./pages/marketing/ReviewsPage'));
const VoicePage                = lazy(() => import('./pages/marketing/VoicePage'));
const InvoicesPage             = lazy(() => import('./pages/marketing/invoices'));
const ProductsPage             = lazy(() => import('./pages/marketing/products/ProductsPage'));
const SubscriptionsPage        = lazy(() => import('./pages/marketing/subscriptions/SubscriptionsPage'));
const OrderFormsPage           = lazy(() => import('./pages/marketing/orderForms/OrderFormsPage'));
const BrandingSettingsPage     = lazy(() => import('./pages/marketing/BrandingSettingsPage'));
const ImportWizardPage         = lazy(() => import('./pages/marketing/imports'));
// GHL-parity settings/tools UIs
const ApiKeysPage              = lazy(() => import('./pages/marketing/settings/apiKeys'));
const ModulesPage              = lazy(() => import('./pages/marketing/settings/modules'));
const WebhooksPage             = lazy(() => import('./pages/marketing/settings/webhooks'));
const InboundWebhooksPage      = lazy(() => import('./pages/marketing/settings/inboundWebhooks'));
// Settings→Connections is the Integrations TAB of the Account Center now.
const TwoFactorPage            = lazy(() => import('./pages/marketing/settings/twoFactor'));
const RolesPage                = lazy(() => import('./pages/marketing/settings/roles'));
const CompliancePage           = lazy(() => import('./pages/marketing/settings/compliance'));
// AI Studio + UGC Personas live in Growth Studio's Create tab; Brand Kit and
// Brand Brain are tabs of the ONE Brand page (/branding).
const SocialCampaignsPage      = lazy(() => import('./pages/marketing/socialCampaigns/SocialCampaignsPage'));
const SocialCampaignDetailPage = lazy(() => import('./pages/marketing/socialCampaigns/SocialCampaignDetailPage'));
const IvrMenusPage             = lazy(() => import('./pages/marketing/voice/ivr'));
const AffiliatesPage           = lazy(() => import('./pages/marketing/experiments/affiliates'));

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

// Unknown paths: signed-in users keep deep-link recovery into the app; everyone
// else lands on the public marketing home rather than being bounced to /login.
function CatchAllRedirect() {
  const isAuthenticated = useMarketingAuthStore((s) => s.isAuthenticated);
  return <Navigate to={isAuthenticated ? '/dashboard' : '/'} replace />;
}

/**
 * Redirect that PRESERVES the current query string and force-sets extras.
 * Needed where a BACKEND OAuth callback 302s the browser to a legacy path with
 * result params (e.g. /ads?connect=… → /reports?tab=ads&connect=…) — a plain
 * <Navigate to> would drop them and the post-OAuth dialog would never open.
 */
function RedirectMergingParams({ to, set }: { to: string; set: Record<string, string> }) {
  const [params] = useSearchParams();
  const merged = new URLSearchParams(params);
  for (const [k, v] of Object.entries(set)) merged.set(k, v);
  return <Navigate to={`${to}?${merged.toString()}`} replace />;
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
      {/* Public marketing home (Jeeta landing). Stays public even when signed
          in — the nav surfaces an "Open app" CTA in that case. */}
      <Route path="/"         element={<S><LandingPage /></S>} />
      {/* Public legal pages — linked from the landing footer. */}
      <Route path="/privacy"  element={<S><PrivacyPage /></S>} />
      <Route path="/terms"    element={<S><TermsPage /></S>} />
      <Route path="/login"    element={<S><MarketingLoginPage /></S>} />
      <Route path="/register" element={<S><RegisterWorkspacePage /></S>} />
      {/* Public web-chat surface — embedded in an iframe by widget.js. */}
      <Route path="/widget"   element={<S><WidgetChatPage /></S>} />
      {/* Public self-service booking page (no auth). */}
      <Route path="/book/:ws/:cal" element={<S><PublicBookingPage /></S>} />
      {/* Standalone affiliate self-serve portal (token-authenticated, no session). */}
      <Route path="/affiliate-portal" element={<S><AffiliatePortalPage /></S>} />

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
          <Route path="/dashboard" element={<S><MarketingDashboardPage /></S>} />
          <Route path="/inbox"     element={<S><InboxPage /></S>} />
          <Route path="/leads"     element={<S><LeadsPage /></S>} />
          <Route path="/leads/new" element={<S><CreateLeadPage /></S>} />
          <Route path="/leads/:id" element={<S><LeadDetailPage /></S>} />
          <Route path="/leads/:id/edit" element={<S><CreateLeadPage /></S>} />
          <Route path="/companies" element={<S><CompaniesPage /></S>} />
          <Route path="/tasks"          element={<S><TasksPage /></S>} />
          <Route path="/calendar"       element={<S><CalendarPage /></S>} />
          <Route path="/opportunities"  element={<S><OpportunitiesPage /></S>} />
          {/* Offers | Estimates | Documents — ONE hub, tabs at ?tab= */}
          <Route path="/documents"      element={<S><DocumentsHubPage /></S>} />
          {/* Overview | Ads | Performance | Analytics — ONE page, tabs at ?tab= */}
          <Route path="/reports"        element={<S><ReportsPage /></S>} />
          {/* Backend ads-OAuth callbacks 302 to /ads?connect=… — params must survive. */}
          <Route path="/ads"            element={<RedirectMergingParams to="/reports" set={{ tab: 'ads' }} />} />
          <Route path="/performance"    element={<RedirectMergingParams to="/reports" set={{ tab: 'performance' }} />} />
          <Route path="/analytics"      element={<RedirectMergingParams to="/reports" set={{ tab: 'analytics' }} />} />
          {/* Growth Studio is Autopilot-first: /studio IS the autopilot console;
              the manual tools live behind ?view=tools&tab=… */}
          <Route path="/studio"         element={<S><GrowthStudioPage /></S>} />
          <Route path="/budget"         element={<Navigate to="/studio" replace />} />
          <Route path="/trends"         element={<Navigate to="/studio?view=tools&tab=trends" replace />} />
          <Route path="/content-calendar" element={<Navigate to="/studio?view=tools&tab=calendar" replace />} />
          <Route path="/commissions"    element={<S><CommissionsPage /></S>} />
          <Route path="/installations"  element={<S><InstallationsPage /></S>} />
          {/* Calls | Power Dialer — ONE page, tabs at ?tab= */}
          <Route path="/calls"          element={<S><CallsPage /></S>} />
          <Route path="/prospecting"    element={<S><ProspectingPage /></S>} />
          <Route path="/billing"        element={<S><BillingPage /></S>} />
          {/* In-app help center (connection guides) — available to everyone. */}
          <Route path="/help"           element={<S><HelpPage /></S>} />
          <Route path="/help/:slug"     element={<S><HelpPage /></S>} />
          {/* Self-service 2FA — available to every authenticated marketing user. */}
          <Route path="/settings/two-factor" element={<S><TwoFactorPage /></S>} />
        </Route>
        <Route element={<MarketingProtectedRoute requiredRole={MarketingRole.MANAGER} />}>
          <Route element={<MarketingLayout />}>
            <Route path="/users"       element={<S><MarketingUsersPage /></S>} />
            <Route path="/targets"     element={<S><TargetsPage /></S>} />
            <Route path="/accounts"    element={<S><AccountCenterPage /></S>} />
            <Route path="/settings/custom-fields" element={<S><CustomFieldsPage /></S>} />
            <Route path="/settings/pipelines" element={<S><PipelineSettingsPage /></S>} />
            <Route path="/tags" element={<S><TagsPage /></S>} />
            <Route path="/settings/tags" element={<Navigate to="/tags" replace />} />
            <Route path="/segments" element={<S><SegmentsPage /></S>} />
            <Route path="/settings/segments" element={<Navigate to="/segments" replace />} />
            <Route path="/import" element={<S><ImportWizardPage /></S>} />
            <Route path="/settings/import" element={<Navigate to="/import" replace />} />
            <Route path="/memberships/courses"            element={<S><CoursesPage /></S>} />
            <Route path="/memberships/courses/:id"        element={<S><CourseEditorPage /></S>} />
            {/* Agency console (Epic D) — each page self-guards on workspace.kind === AGENCY
                (AgencyGuard); backend additionally 403s every /agency route for non-agencies. */}
            <Route path="/agency/locations"  element={<S><AgencyLocationsPage /></S>} />
            <Route path="/agency/snapshots"  element={<S><AgencySnapshotsPage /></S>} />
            <Route path="/agency/rebilling"  element={<S><AgencyRebillingPage /></S>} />
            <Route path="/research"    element={<S><ResearchSettingsPage /></S>} />
            <Route path="/research/suggestions" element={<S><ResearchSuggestionsPage /></S>} />
            {/* Channels / Canned Responses / AI Agents / Knowledge → /inbox?tab=… */}
            <Route path="/settings/sending-domains" element={<S><SendingDomainsPage /></S>} />
            <Route path="/settings/custom-domains" element={<S><CustomDomainsPage /></S>} />
            {/* Tax Rates + Coupons → /products?tab=… */}
            <Route path="/automations" element={<S><AutomationsPage /></S>} />
            <Route path="/automations/new" element={<S><AutomationBuilderPage /></S>} />
            <Route path="/automations/:id/edit" element={<S><AutomationBuilderPage /></S>} />
            <Route path="/campaigns"   element={<Navigate to="/studio?view=tools&tab=campaigns" replace />} />
            <Route path="/email-templates" element={<S><EmailTemplatesPage /></S>} />
            <Route path="/sites"       element={<S><SitesPage /></S>} />
            <Route path="/booking"     element={<S><BookingSettingsPage /></S>} />
            <Route path="/appointments" element={<S><AppointmentsPage /></S>} />
            <Route path="/reviews"     element={<S><ReviewsPage /></S>} />
            <Route path="/voice"       element={<S><VoicePage /></S>} />
            <Route path="/invoices"    element={<S><InvoicesPage /></S>} />
            <Route path="/products"    element={<S><ProductsPage /></S>} />
            <Route path="/subscriptions" element={<S><SubscriptionsPage /></S>} />
            <Route path="/order-forms"   element={<S><OrderFormsPage /></S>} />
            {/* Business | Brand Kit | Brand Brain — ONE Brand page, tabs at ?tab= */}
            <Route path="/branding"    element={<S><BrandingSettingsPage /></S>} />
            {/* GHL-parity settings/tools UIs (manager-gated; server-side OWNER/MANAGER). */}
            <Route path="/settings/api-keys"    element={<S><ApiKeysPage /></S>} />
            <Route path="/settings/modules"     element={<S><ModulesPage /></S>} />
            <Route path="/settings/webhooks"    element={<S><WebhooksPage /></S>} />
            <Route path="/settings/inbound-webhooks" element={<S><InboundWebhooksPage /></S>} />
            {/* Backend calendar-OAuth callbacks 302 to /settings/connections?gcal=… —
                params must survive into the Account Center's Integrations tab. */}
            <Route path="/settings/connections" element={<RedirectMergingParams to="/accounts" set={{ tab: 'integrations' }} />} />
            <Route path="/settings/roles"       element={<S><RolesPage /></S>} />
            <Route path="/settings/compliance"  element={<S><CompliancePage /></S>} />
            {/* Telephony + Voice-AI setup now lives in the Account Center. */}
            <Route path="/settings/telephony"   element={<Navigate to="/accounts" replace />} />
            <Route path="/settings/voice-ai"    element={<Navigate to="/accounts" replace />} />
            <Route path="/social"      element={<Navigate to="/studio?view=tools&tab=campaigns" replace />} />
            <Route path="/social-campaigns"      element={<Navigate to="/studio?view=tools&tab=campaigns" replace />} />
            <Route path="/social-campaigns/:id"  element={<S><SocialCampaignDetailPage /></S>} />
            <Route path="/trigger-links" element={<S><TriggerLinksPage /></S>} />
            <Route path="/voice/ivr"   element={<S><IvrMenusPage /></S>} />
            <Route path="/affiliates"  element={<S><AffiliatesPage /></S>} />
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
      <Route path="*" element={<CatchAllRedirect />} />
    </Routes>
  );
}
