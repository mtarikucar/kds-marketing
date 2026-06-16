import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, LogOut } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { APP_VERSION } from '../../../lib/env';
import { NAV_GROUPS, visibleNav, type NavItem } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
  ].join(' ');

export default function MarketingSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { t } = useTranslation('marketing');
  const { user, logout } = useMarketingAuthStore();
  const { has } = useEntitlements();
  const { isAgency } = useWorkspaceProfile();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // Collapsible groups (only Growth, today) remember their open state per group id.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Role + entitlement + agency-kind gated, with emptied groups already dropped.
  const groups = visibleNav(NAV_GROUPS, { isManager, has, isAgency });

  const renderItem = (item: NavItem) => (
    <NavLink key={item.path} to={item.path} onClick={onNavigate} className={linkClass}>
      {({ isActive }) => (
        <>
          {/* Active accent bar — the primary wayfinding cue. */}
          <span
            className={`absolute inset-y-1 start-0 w-0.5 rounded-full bg-primary transition-opacity ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <item.icon className="h-5 w-5 shrink-0" />
          <span className="truncate">{t(item.labelKey, item.label)}</span>
        </>
      )}
    </NavLink>
  );

  return (
    <aside className="flex h-screen w-64 flex-col border-e border-border bg-surface">
      {/* Brand */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary-hover shadow-sm">
          <span className="text-sm font-bold text-primary-foreground">M</span>
        </div>
        <span className="font-display text-base font-semibold text-foreground">
          {t('login.title')}
        </span>
      </div>

      {/* Navigation */}
      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {groups.map((group) => {
          const items = group.items;
          const isCollapsed = group.collapsible && collapsed[group.id];

          return (
            <div key={group.id} className="space-y-1">
              {group.collapsible ? (
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))
                  }
                  className="flex w-full items-center justify-between px-3 pb-1 text-micro font-semibold uppercase text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>{t(group.labelKey, group.label)}</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  />
                </button>
              ) : (
                <p className="px-3 pb-1 text-micro font-semibold uppercase text-muted-foreground">
                  {t(group.labelKey, group.label)}
                </p>
              )}
              {!isCollapsed && items.map(renderItem)}
            </div>
          );
        })}
      </nav>

      {/* User card + logout */}
      <div className="shrink-0 border-t border-border px-3 py-3">
        <div className="mb-2 flex items-center gap-3 rounded-lg px-2 py-1.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            <span className="text-sm font-semibold text-primary">
              {user?.firstName?.[0]}
              {user?.lastName?.[0]}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.role === 'OWNER'
                ? t('role.OWNER', 'Owner')
                : user?.role === 'MANAGER'
                  ? t('role.MANAGER')
                  : t('role.REP')}
            </p>
          </div>
        </div>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-danger-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogOut className="h-4 w-4" />
          {t('nav.logout')}
        </button>
        <p className="mt-2 select-text text-center text-[10px] text-muted-foreground">
          {APP_VERSION}
        </p>
      </div>
    </aside>
  );
}
