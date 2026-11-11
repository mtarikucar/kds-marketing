import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookText,
  Bot,
  Compass,
  Home,
  Inbox,
  KeyRound,
  LogOut,
  Phone,
  Plug,
  ShieldCheck,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
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
  ThemeToggle,
  cn,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { currentMembership } from '@/lib/roles';
import { Brand } from './Brand';

type NavKey =
  | 'studio'
  | 'inbox'
  | 'people'
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

const NAV: { to: string; key: NavKey; Icon: LucideIcon }[] = [
  { to: '/', key: 'home', Icon: Home },
  { to: '/inbox', key: 'inbox', Icon: Inbox },
  { to: '/people', key: 'people', Icon: UserRound },
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

function NavItems({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const { t } = useTranslation();
  return (
    <>
      {NAV.map(({ to, key, Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            cn(
              'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
              orientation === 'horizontal' && 'py-1.5',
            )
          }
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          {t(`nav.${key}`)}
        </NavLink>
      ))}
    </>
  );
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
      <div className="flex min-h-screen items-center justify-center bg-background">
        <QueryState query={session} />
      </div>
    );
  }

  const me = session.data;
  const current = currentMembership(me);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-e border-border bg-surface px-3 py-4 md:flex">
        <Brand className="px-2" />
        <nav aria-label={t('nav.label')} className="flex flex-col gap-1">
          <NavItems orientation="vertical" />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5 sm:px-6">
          <Brand className="md:hidden" />
          <div className="flex min-w-0 items-center gap-2">
            <span className="sr-only">{t('shell.workspace')}</span>
            <WorkspaceSwitcher me={me} />
            {current && <WorkspaceStatusBadge status={current.workspace_status} />}
          </div>
          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <span
              className="hidden max-w-[12rem] truncate text-sm text-muted-foreground lg:inline"
              title={t('shell.signedInAs', { name: me.email })}
            >
              {me.display_name}
            </span>
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

        <nav
          aria-label={t('nav.label')}
          className="flex gap-1 overflow-x-auto border-b border-border bg-surface px-3 py-2 md:hidden"
        >
          <NavItems orientation="horizontal" />
        </nav>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            {current ? (
              // Keyed by workspace: a switch mounts every page afresh, so no local state (an open
              // editor, a half-typed form) carries over and is saved into the other workspace.
              <Outlet key={me.current_workspace ?? 'none'} />
            ) : me.memberships.length > 0 ? (
              <EmptyState
                title={t('shell.chooseWorkspace')}
                description={t('shell.chooseWorkspaceBody')}
              />
            ) : (
              <EmptyState title={t('shell.noWorkspace')} description={t('shell.noWorkspaceBody')} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
