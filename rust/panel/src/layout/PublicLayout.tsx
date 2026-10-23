import { Outlet } from 'react-router-dom';
import { LanguageSwitcher, ThemeToggle } from '@/components/ui';
import { Brand } from './Brand';

/** Sign-in, sign-up, invite and platform sign-in: one centred card, no session needed. */
export function PublicLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Brand />
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center">
        <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
