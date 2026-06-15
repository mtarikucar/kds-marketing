import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Building2, CreditCard, LogOut, Repeat, ShieldCheck, User } from 'lucide-react';
import { usePlatformAuthStore } from '../../../store/platformAuthStore';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/components/ui/cn';

/**
 * Platform (superadmin) realm shell. The realm has its own auth store + token,
 * separate from the marketing realm. The guard lives here at the realm boundary:
 * an unauthenticated operator is bounced to /platform/login — the same behavior
 * the platform pages used to do inline, now hoisted so every nested route shares
 * one shell + one redirect. Per-route ErrorBoundary keyed on pathname keeps the
 * shell alive when a page's query throws (and auto-clears on navigation).
 */

const NAV_ITEMS = [
  { to: '/platform/workspaces', label: 'Workspaces', Icon: Building2 },
  { to: '/platform/payments', label: 'Payments', Icon: CreditCard },
  { to: '/platform/routines', label: 'Routines', Icon: Repeat },
] as const;

export default function PlatformLayout() {
  const location = useLocation();
  const { isAuthenticated, operator, logout } = usePlatformAuthStore();

  // Realm guard — preserves the original per-page redirect, now hoisted to the
  // layout so it runs once for the whole platform realm.
  if (!isAuthenticated) {
    return <Navigate to="/platform/login" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          {/* Brand mark */}
          <NavLink
            to="/platform/workspaces"
            className="flex items-center gap-2 font-display text-sm font-semibold text-foreground"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="hidden sm:inline">Platform Console</span>
          </NavLink>

          {/* Primary nav */}
          <nav className="flex items-center gap-1" aria-label="Platform navigation">
            {NAV_ITEMS.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-surface-muted text-foreground'
                      : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>

          {/* Right side */}
          <div className="ms-auto flex items-center gap-2">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label="Operator menu" variant="ghost" size="sm">
                  <User className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel className="truncate">
                  {operator?.name ?? operator?.email ?? 'Operator'}
                </DropdownMenuLabel>
                {operator?.email && operator?.name && (
                  <p className="truncate px-2 pb-1 text-micro text-muted-foreground">
                    {operator.email}
                  </p>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger focus:text-danger"
                  onClick={() => logout()}
                >
                  <LogOut className="me-2 h-4 w-4" aria-hidden="true" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
