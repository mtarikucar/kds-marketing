import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { listWorkspaces } from '@/api/platform';
import { QueryState } from '@/components/QueryState';
import { PLATFORM_WORKSPACES_KEY } from '@/pages/platform/WorkspacesPage';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LanguageSwitcher, ThemeToggle } from '@/components/ui';
import { Brand } from './Brand';

/** The platform console's frame: no workspace, no user session; the operator cookie only. */
export function PlatformShell() {
  const { t } = useTranslation();
  const location=useLocation();
  const access=useQuery({queryKey:PLATFORM_WORKSPACES_KEY,queryFn:listWorkspaces,retry:false});
  if(!access.isSuccess) return <QueryState query={access}/>;
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5 sm:px-6">
        <Brand suffix={t('platform.console')} />
        <div className="ms-auto flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <nav className="flex flex-wrap gap-4" aria-label={t('platform.console')}>
            <NavLink to="/platform/workspaces">{t('platform.workspaces.title')}</NavLink>
            <NavLink to="/platform/payments">{t('platform.payments.title')}</NavLink>
            <NavLink to="/platform/health">{t('platform.health.title')}</NavLink>
          </nav>
          <Outlet key={location.key} />
        </div>
      </main>
    </div>
  );
}
