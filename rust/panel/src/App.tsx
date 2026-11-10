import { BillingPage } from '@/pages/BillingPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { StudioPage } from './pages/StudioPage';
import { Navigate, type RouteObject } from 'react-router-dom';
import { AppRoot } from '@/layout/AppRoot';
import { PlatformShell } from '@/layout/PlatformShell';
import { PublicLayout } from '@/layout/PublicLayout';
import { Shell } from '@/layout/Shell';
import { AcceptInvitePage } from '@/pages/AcceptInvitePage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { BudgetPage } from '@/pages/BudgetPage';
import { CallDetail } from '@/pages/CallDetail';
import { CallsPage } from '@/pages/CallsPage';
import { CapabilitiesPage } from '@/pages/CapabilitiesPage';
import { ConnectPage } from '@/pages/ConnectPage';
import { InboxPage } from '@/pages/InboxPage';
import { PeoplePage } from '@/pages/PeoplePage';
import { ProspectsPage } from '@/pages/ProspectsPage';
import { ProspectDetail } from '@/pages/ProspectDetail';
import { ResearchTasksPage } from '@/pages/ResearchTasksPage';
import { OutreachPage } from '@/pages/OutreachPage';
import { OutreachCampaign } from '@/pages/OutreachCampaign';
import { OutreachSettings } from '@/pages/OutreachSettings';
import { OutreachTemplates } from '@/pages/OutreachTemplates';
import { InboxMerges } from '@/pages/InboxMerges';
import { InboxCommissions } from '@/pages/InboxCommissions';
import { HomePage } from '@/pages/HomePage';
import { ModulesPage } from '@/pages/modules/ModulesPage';
import { ModuleDetailPage } from '@/pages/modules/ModuleDetailPage';
import { WorkspaceActivityPage } from '@/pages/modules/WorkspaceActivityPage';
import { ModuleGate } from '@/layout/ModuleGate';
import { LedgerPage } from '@/pages/LedgerPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { RolesPage } from '@/pages/RolesPage';
import { StrategyPage } from '@/pages/StrategyPage';
import { TeamPage } from '@/pages/TeamPage';
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
          { path: 'activity', element: <WorkspaceActivityPage /> },
          { path: 'billing', element: <BillingPage /> },
          { path: 'onboarding', element: <OnboardingPage /> },
          { path: 'inbox', element: <InboxPage /> },
          { path: 'inbox/:conversationId', element: <InboxPage /> },
          { path: 'inbox/merges', element: <InboxMerges /> },
          { path: 'inbox/commissions', element: <InboxCommissions /> },
          { path: 'people', element: <ModuleGate moduleId="people"><PeoplePage /></ModuleGate> },
          { path: 'prospects', element: <ModuleGate moduleId="prospects"><ProspectsPage /></ModuleGate> },
          { path: 'prospects/tasks', element: <ModuleGate moduleId="prospects"><ResearchTasksPage /></ModuleGate> },
          { path: 'prospects/:prospectId', element: <ModuleGate moduleId="prospects"><ProspectDetail /></ModuleGate> },
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
          { path: 'team', element: <TeamPage /> },
          { path: 'team/distribution', element: <DistributionPage /> },
          { path: 'roles', element: <RolesPage /> },
          { path: 'api-keys', element: <ApiKeysPage /> },
          { path: 'agents', element: <AgentsPage /> },
          { path: 'ledger', element: <LedgerPage /> },
          { path: 'studio', element: <ModuleGate moduleId="growth-studio"><StudioPage /></ModuleGate> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
