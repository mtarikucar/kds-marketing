import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookText,
  Bot,
  Compass,
  Home,
  Inbox,
  KeyRound,
  LogOut,
  Mail,
  Menu,
  Phone,
  Plug,
  ShieldCheck,
  Target,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout, switchWorkspace } from '@/api/auth';
import type { MeOut, Permission } from '@/api/types';
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
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { can, currentMembership } from '@/lib/roles';
import { Brand } from './Brand';

type NavKey =
  | 'studio'
  | 'inbox'
  | 'people'
  | 'prospects'
  | 'outreach'
  | 'calls'
  | 'home'
  | 'strategy'
  | 'capabilities'
  | 'budget'
  | 'team'
  | 'roles'
  | 'apiKeys'
  | 'agents'
  | 'ledger';

/** The menu; an entry with a `permission` is listed only for those who hold it. */
const NAV: { to: string; key: NavKey; Icon: LucideIcon; permission?: Permission }[] = [
  { to: '/', key: 'home', Icon: Home },
  { to: '/inbox', key: 'inbox', Icon: Inbox },
  { to: '/people', key: 'people', Icon: UserRound },
  { to: '/prospects', key: 'prospects', Icon: Target, permission: 'prospects.work' },
  { to: '/outreach', key: 'outreach', Icon: Mail, permission: 'outreach.work' },
  { to: '/calls', key: 'calls', Icon: Phone },
  { to: '/strategy', key: 'strategy', Icon: Compass },
  { to: '/capabilities', key: 'capabilities', Icon: Plug },
  { to: '/budget', key: 'budget', Icon: Wallet },
  { to: '/team', key: 'team', Icon: Users },
  { to: '/roles', key: 'roles', Icon: ShieldCheck },
  { to: '/api-keys', key: 'apiKeys', Icon: KeyRound },
  { to: '/agents', key: 'agents', Icon: Bot },
  { to: '/studio', key: 'studio', Icon: BookText },
  { to: '/ledger', key: 'ledger', Icon: BookText },
];

const NAV_GROUPS: { label: 'workGroup' | 'growthGroup' | 'workspaceGroup'; keys: NavKey[] }[] = [
  { label: 'workGroup', keys: ['home', 'inbox', 'people', 'prospects', 'outreach', 'calls'] },
  { label: 'growthGroup', keys: ['strategy', 'studio'] },
  { label: 'workspaceGroup', keys: ['capabilities', 'budget', 'team', 'roles', 'apiKeys', 'agents', 'ledger'] },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const me = useSession().data;
  return <>
    {NAV_GROUPS.map((group) => (
      <div key={group.label} className="space-y-1">
        <p className="px-3 pb-2 pt-4 text-xs text-muted-foreground">{t(`nav.${group.label}`)}</p>
        {group.keys.map((key) => NAV.find((item) => item.key === key)!)
          .filter(({ permission }) => !permission || can(me, permission))
          .map(({ to, key, Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} onClick={onNavigate}
              className={({ isActive }) => cn(
                'relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors md:min-h-9',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-surface font-medium text-foreground shadow-xs before:absolute before:inset-y-3 before:start-0 before:w-0.5 before:bg-brand-accent'
                  : 'text-muted-foreground hover:bg-surface/70 hover:text-foreground',
              )}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t(`nav.${key}`)}
            </NavLink>
          ))}
      </div>
    ))}
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
export function Shell() {
  const { t } = useTranslation();
  const session = useSession();
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
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3 sm:px-8">
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

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto flex w-full min-w-0 max-w-[1536px] flex-col gap-6">
            {current ? (
              // Keyed by workspace: a switch mounts every page afresh, so no local state (an open
              // editor, a half-typed form) carries over and is saved into the other workspace.
              <Outlet key={me.current_workspace ?? 'none'} />
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
