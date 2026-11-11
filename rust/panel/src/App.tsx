import { LegacyRedirect } from '@/layout/LegacyRedirect';
import { UsersPage } from '@/pages/UsersPage';
import { ContentPage } from '@/pages/content/ContentPage';
import { SocialPage } from '@/pages/social/SocialPage';
import { AdsPage } from '@/pages/ads/AdsPage';
import { MaterialsPage } from '@/pages/materials/MaterialsPage';
import { BillingPage } from '@/pages/BillingPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { Navigate, type RouteObject } from 'react-router-dom';
import { AppRoot } from '@/layout/AppRoot';
import { PlatformShell } from '@/layout/PlatformShell';
import { PublicLayout } from '@/layout/PublicLayout';
import { Shell } from '@/layout/Shell';
import { AcceptInvitePage } from '@/pages/AcceptInvitePage';
import { AgentsPage } from '@/pages/AgentsPage';
import { BudgetPage } from '@/pages/BudgetPage';
import { CallDetail } from '@/pages/CallDetail';
import { CallsPage } from '@/pages/CallsPage';
import { CapabilitiesPage } from '@/pages/CapabilitiesPage';
import { ConnectPage } from '@/pages/ConnectPage';
import { InboxPage } from '@/pages/InboxPage';
import { PeoplePage } from '@/pages/PeoplePage';
import { ProspectsPage } from '@/pages/ProspectsPage';
import { ResearchTasksPage } from '@/pages/ResearchTasksPage';
import { OutreachPage } from '@/pages/OutreachPage';
import { OutreachCampaign } from '@/pages/OutreachCampaign';
import { OutreachSettings } from '@/pages/OutreachSettings';
import { OutreachTemplates } from '@/pages/OutreachTemplates';
import { InboxMerges } from '@/pages/InboxMerges';
import { HomePage } from '@/pages/HomePage';
import { ModulesPage } from '@/pages/modules/ModulesPage';
import { ModuleDetailPage } from '@/pages/modules/ModuleDetailPage';
import { ModuleGate } from '@/layout/ModuleGate';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { StrategyPage } from '@/pages/StrategyPage';
import { DistributionPage } from '@/pages/DistributionPage';
import { PlatformLoginPage } from '@/pages/platform/PlatformLoginPage';
import { PaymentsPage } from '@/pages/platform/PaymentsPage';
import { HealthPage } from '@/pages/platform/HealthPage';
import { WorkspacesPage } from '@/pages/platform/WorkspacesPage';

/** React Router v7 behaviour, opted into now (also silences the v6 deprecation warnings). */
export const ROUTER_FUTURE = {
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_relativeSplatPath: true,
  v7_skipActionErrorRevalidation: true,
} as const;

/** Passed to `<RouterProvider future>`. */
export const PROVIDER_FUTURE = { v7_startTransition: true } as const;

/** Every page of the panel. The server answers each of these paths with `index.html`. */
export const routes: RouteObject[] = [
  {
    element: <AppRoot />,
    children: [
      {
        element: <PublicLayout />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', element: <RegisterPage /> },
          { path: '/invite/:token', element: <AcceptInvitePage /> },
          { path: '/platform/login', element: <PlatformLoginPage /> },
        ],
      },
      {
        path: '/platform',
        element: <PlatformShell />,
        children: [
          { index: true, element: <Navigate to="/platform/workspaces" replace /> },
          { path: 'workspaces', element: <WorkspacesPage /> },
          { path: 'payments', element: <PaymentsPage /> },
          { path: 'health', element: <HealthPage /> },
        ],
      },
      {
        path: '/',
        element: <Shell />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'modules', element: <ModulesPage /> },
          { path: 'modules/:moduleId', element: <ModuleDetailPage /> },
          { path: 'activity', element: <LegacyRedirect to="/" /> },
          { path: 'billing', element: <BillingPage /> },
          { path: 'onboarding', element: <OnboardingPage /> },
          { path: 'inbox', element: <ModuleGate moduleId="inbox"><InboxPage /></ModuleGate> },
          { path: 'inbox/:conversationId', element: <ModuleGate moduleId="inbox"><InboxPage /></ModuleGate> },
          { path: 'inbox/merges', element: <InboxMerges /> },
          { path: 'people', element: <ModuleGate moduleId="people"><PeoplePage /></ModuleGate> },
          { path: 'prospects/tasks', element: <ModuleGate moduleId="prospects"><ResearchTasksPage /></ModuleGate> },
          // One route for the list and a chosen prospect: the page keeps its filters between them.
          { path: 'prospects/:prospectId?', element: <ModuleGate moduleId="prospects"><ProspectsPage /></ModuleGate> },
          { path: 'outreach', element: <ModuleGate moduleId="outreach"><OutreachPage /></ModuleGate> },
          { path: 'outreach/templates', element: <ModuleGate moduleId="outreach"><OutreachTemplates /></ModuleGate> },
          { path: 'outreach/settings', element: <ModuleGate moduleId="outreach"><OutreachSettings /></ModuleGate> },
          { path: 'outreach/new', element: <ModuleGate moduleId="outreach"><OutreachCampaign /></ModuleGate> },
          { path: 'outreach/:campaignId', element: <ModuleGate moduleId="outreach"><OutreachCampaign /></ModuleGate> },
          { path: 'calls', element: <ModuleGate moduleId="calls"><CallsPage /></ModuleGate> },
          { path: 'calls/:callId', element: <ModuleGate moduleId="calls"><CallDetail /></ModuleGate> },
          { path: 'strategy', element: <StrategyPage /> },
          { path: 'capabilities', element: <CapabilitiesPage /> },
          { path: 'connect', element: <ConnectPage /> },
          // Where a provider sends the browser back after signing in (the OAuth redirect URI).
          { path: 'oauth/callback/:provider', element: <OAuthCallbackPage /> },
          { path: 'budget', element: <BudgetPage /> },
          { path: 'team', element: <LegacyRedirect to="/users" /> },
          { path: 'team/distribution', element: <DistributionPage /> },
          { path: 'roles', element: <LegacyRedirect to="/users" /> },
          { path: 'api-keys', element: <LegacyRedirect to="/agents" /> },
          { path: 'agents', element: <AgentsPage /> },
          { path: 'ledger', element: <LegacyRedirect to="/" /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'content', element: <ModuleGate moduleId="content"><ContentPage /></ModuleGate> },
          { path: 'social', element: <ModuleGate moduleId="social"><SocialPage /></ModuleGate> },
          { path: 'ads', element: <ModuleGate moduleId="ads"><AdsPage /></ModuleGate> },
          { path: 'materials', element: <ModuleGate moduleId="materials"><MaterialsPage /></ModuleGate> },
          { path: 'studio', element: <LegacyRedirect /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
