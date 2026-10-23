import { Navigate, type RouteObject } from 'react-router-dom';
import { AppRoot } from '@/layout/AppRoot';
import { PlatformShell } from '@/layout/PlatformShell';
import { PublicLayout } from '@/layout/PublicLayout';
import { Shell } from '@/layout/Shell';
import { AcceptInvitePage } from '@/pages/AcceptInvitePage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { BudgetPage } from '@/pages/BudgetPage';
import { CapabilitiesPage } from '@/pages/CapabilitiesPage';
import { ConnectPage } from '@/pages/ConnectPage';
import { InboxPage } from '@/pages/InboxPage';
import { InboxMerges } from '@/pages/InboxMerges';
import { HomePage } from '@/pages/HomePage';
import { LedgerPage } from '@/pages/LedgerPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { RolesPage } from '@/pages/RolesPage';
import { StrategyPage } from '@/pages/StrategyPage';
import { TeamPage } from '@/pages/TeamPage';
import { PlatformLoginPage } from '@/pages/platform/PlatformLoginPage';
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
        ],
      },
      {
        path: '/',
        element: <Shell />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'inbox', element: <InboxPage /> },
          { path: 'inbox/:conversationId', element: <InboxPage /> },
          { path: 'inbox/merges', element: <InboxMerges /> },
          { path: 'strategy', element: <StrategyPage /> },
          { path: 'capabilities', element: <CapabilitiesPage /> },
          { path: 'connect', element: <ConnectPage /> },
          // Where a provider sends the browser back after signing in (the OAuth redirect URI).
          { path: 'oauth/callback/:provider', element: <OAuthCallbackPage /> },
          { path: 'budget', element: <BudgetPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: 'roles', element: <RolesPage /> },
          { path: 'api-keys', element: <ApiKeysPage /> },
          { path: 'agents', element: <AgentsPage /> },
          { path: 'ledger', element: <LedgerPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
