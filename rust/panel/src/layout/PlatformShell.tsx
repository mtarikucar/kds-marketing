import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { LanguageSwitcher, ThemeToggle } from '@/components/ui';
import { Brand } from './Brand';

/** The platform console's frame: no workspace, no user session; the operator cookie only. */
export function PlatformShell() {
  const { t } = useTranslation();
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
          <Outlet />
        </div>
      </main>
    </div>
  );
}
