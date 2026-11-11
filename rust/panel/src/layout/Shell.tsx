import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Compass,
  Home,
  Plus,
  Layers,
  Lock,
  ChevronDown,
  LogOut,
  Menu,
  Plug,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { logout, switchWorkspace } from '@/api/auth';
import type { MeOut } from '@/api/types';
import { SESSION_KEY, useSession } from '@/auth/useSession';
import { WorkspaceStatusBadge } from '@/components/StatusBadges';
import { QueryState } from '@/components/QueryState';
import {
  Button,
  EmptyState,
  LanguageSwitcher,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  ThemeToggle,
  cn,
  PageFrameContext,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { currentMembership } from '@/lib/roles';
import { Brand } from './Brand';
import { useModules, modulePath, moduleReady, moduleVisibleTo } from '@/lib/modules';

type NavItem = { to: string; label: string; Icon: LucideIcon; locked?: boolean };

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { t, i18n } = useTranslation();
  const tr = i18n.language.startsWith('tr');
  const me = useSession().data;
  const modules = useModules();
  const location = useLocation();
  const core: NavItem[] = [
    { to: '/', label: t('nav.home'), Icon: Home },
    { to: '/strategy', label: t('nav.strategy'), Icon: Compass },
  ];
  const management: NavItem[] = [
    { to: '/budget', label: t('nav.budget'), Icon: Wallet },
    { to: '/users', label: t('nav.users'), Icon: Users },
    { to: '/capabilities', label: t('nav.capabilities'), Icon: Plug },
    { to: '/agents', label: t('nav.agents'), Icon: Bot },
  ];
  const lockedLabel = tr ? 'Kilitli: gerekli yetenek bağlı değil' : 'Locked: its capability is not connected';
  const link = ({ to, label, Icon, locked }: NavItem) => (
    <NavLink key={to} to={to} end={to === '/'} onClick={onNavigate}
      className={({ isActive }) => cn(
        'relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors md:min-h-9',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'bg-surface font-medium text-foreground shadow-xs before:absolute before:inset-y-3 before:start-0 before:w-0.5 before:bg-brand-accent'
          : 'text-muted-foreground hover:bg-surface/70 hover:text-foreground',
      )}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{label}</span>
      {locked && <Lock className="ms-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={lockedLabel} />}
    </NavLink>
  );
  return <>
    <div className="space-y-1 pt-4">{core.map(link)}</div>
    <div className="space-y-1">
      <p className="px-3 pb-2 pt-4 text-xs text-muted-foreground">{tr ? 'Eklenen modüller' : 'Installed modules'}</p>
      {modules.isPending && <p className="px-3 py-2 text-xs text-muted-foreground" role="status">{t('common.loading')}</p>}
      {modules.isError && <button className="px-3 py-2 text-left text-xs text-destructive underline" onClick={() => void modules.refetch()}>{tr ? 'Modüller yüklenemedi. Yeniden dene' : 'Modules unavailable. Retry'}</button>}
      {modules.data?.modules.filter(m => m.installed && !m.required && moduleVisibleTo(m, me)).map(m => ({
        to: modulePath(m), label: m.blueprint.name, Icon: Layers, locked: !moduleReady(modules.data, m.blueprint.id),
      })).map(link)}
      {link({ to: '/modules', label: tr ? 'Modül ekle' : 'Add module', Icon: Plus })}
    </div>
    <details className="group border-t border-border pt-3" open={management.some(item => location.pathname === item.to)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-md px-3 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {tr ? 'Yönetim' : 'Manage'}<ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-1">{management.map(link)}</div>
    </details>
  </>;
}

function WorkspaceSwitcher({ me }: { me: MeOut }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const switching = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: async (next) => {
      queryClient.setQueryData(SESSION_KEY, next);
      // Everything else belonged to the previous workspace.
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
      toast.success(t('shell.switched'));
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const current = currentMembership(me);
  // A choice is offered whenever there is one to make: several workspaces, or memberships but no
  // current workspace (e.g. after accepting an invitation while signed in elsewhere), which would
  // otherwise leave the user with nothing to open.
  const canChoose = me.memberships.length > 1 || (current == null && me.memberships.length > 0);

  if (!canChoose) {
    return (
      <span className="truncate text-sm font-medium text-foreground">
        {current?.workspace_name ?? t('shell.noWorkspace')}
      </span>
    );
  }
  return (
    <Select
      value={current?.workspace_id}
      onValueChange={(id) => switching.mutate(id)}
      disabled={switching.isPending}
    >
      <SelectTrigger aria-label={t('shell.switchWorkspace')} className="h-8 w-48 sm:w-56">
        <SelectValue placeholder={t('shell.noWorkspace')} />
      </SelectTrigger>
      <SelectContent>
        {me.memberships.map((m) => (
          <SelectItem key={m.workspace_id} value={m.workspace_id}>
            {m.workspace_name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The signed-in frame: header (workspace, status, language, theme, sign out), menu, page. */
/**
 * Every other page: no outer margin, the page title as a full-width bar under the header (the
 * first PageHeader, drawn edge to edge with a bottom rule), the content using the full width with
 * a 16px gutter so text never touches the sidebar's rule.
 */
const PAGE_FRAME = 'gap-5 px-4 pb-5 [&:not(:has([data-page-header]))]:pt-4';

/** Workspace screens that fill the whole content area edge to edge, under the 61px header. */
function isFullBleed(pathname: string): boolean {
  if (pathname === '/' || pathname === '/inbox' || pathname.startsWith('/inbox/')) return true;
  // The prospect pool and a prospect in it; its research tasks are an ordinary page.
  return pathname === '/prospects' || (pathname.startsWith('/prospects/') && pathname !== '/prospects/tasks');
}

export function Shell() {
  const { t } = useTranslation();
  const session = useSession();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSettled: () => {
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });

  if (!session.data) {
    return (
      <main id="main-content" tabIndex={-1} className="flex min-h-screen items-center justify-center bg-background p-6">
        <QueryState query={session} />
      </main>
    );
  }

  const me = session.data;
  const current = currentMembership(me);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-e border-border bg-surface-muted/60 md:flex">
        <Brand className="px-6 pb-3 pt-6" />
        <nav aria-label={t('nav.label')} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-6 pt-0">
          <NavItems />
        </nav>
        <div className="flex items-center gap-3 border-t border-border px-6 py-4">
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium">{me.display_name.trim().slice(0, 1).toLocaleUpperCase()}</span>
          <div className="min-w-0">
            <p className="truncate text-sm">{me.display_name}</p>
            <p className="truncate text-xs text-muted-foreground" title={me.email}>{me.email}</p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="h-10 w-10 px-0 md:hidden" aria-label={t('nav.label')}><Menu className="h-5 w-5" aria-hidden="true" /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="max-w-[288px] bg-background" aria-describedby={undefined}>
              <SheetTitle><Brand /></SheetTitle>
              <nav aria-label={t('nav.label')} className="flex flex-col gap-4"><NavItems onNavigate={() => setMenuOpen(false)} /></nav>
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-caption text-muted-foreground sm:inline">{t('shell.workspace')}</span>
            <WorkspaceSwitcher me={me} />
            {current && <WorkspaceStatusBadge status={current.workspace_status} />}
          </div>
          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signOut.mutate()}
              loading={signOut.isPending}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('shell.logout')}</span>
              <span className="sr-only sm:hidden">{t('shell.logout')}</span>
            </Button>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1">
          <div className={cn('flex w-full min-w-0 flex-col', !isFullBleed(pathname) && PAGE_FRAME)}>
            {current ? (
              // Keyed by workspace: a switch mounts every page afresh, so no local state (an open
              // editor, a half-typed form) carries over and is saved into the other workspace.
              <PageFrameContext.Provider value={!isFullBleed(pathname)}>
                <Outlet key={me.current_workspace ?? 'none'} />
              </PageFrameContext.Provider>
            ) : me.memberships.length > 0 ? (
              <EmptyState
                headingLevel="h1"
                title={t('shell.chooseWorkspace')}
                description={t('shell.chooseWorkspaceBody')}
              />
            ) : (
              <EmptyState headingLevel="h1" title={t('shell.noWorkspace')} description={t('shell.noWorkspaceBody')} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
