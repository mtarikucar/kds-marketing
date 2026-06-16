import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut, PanelLeftClose, PanelLeft } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { APP_VERSION } from '../../../lib/env';
import { NAV_HUBS, visibleNav, findActiveHub, type NavHub } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { cn } from '../../../components/ui/cn';

const STORAGE_KEY = 'kds-sidebar-collapsed';

/**
 * Primary navigation rail — a lean list of GoHighLevel-style HUBS (Dashboard,
 * Conversations, Contacts, …). The active hub is the one owning the current
 * route; clicking a hub lands on its first page (its sub-nav then shows the
 * sibling pages — see HubSubNav). Settings is pinned at the bottom as a gear.
 * Collapses to an icon-rail (persisted).
 */
export default function MarketingSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { t } = useTranslation('marketing');
  const { user, logout } = useMarketingAuthStore();
  const { has } = useEntitlements();
  const { isAgency } = useWorkspaceProfile();
  const location = useLocation();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });

  const hubs = visibleNav(NAV_HUBS, { isManager, has, isAgency });
  const mainHubs = hubs.filter((h) => (h.area ?? 'main') === 'main');
  const settingsHub = hubs.find((h) => h.area === 'settings');
  const activeHub = findActiveHub(hubs, location.pathname);

  const hubTarget = (h: NavHub) => h.path ?? h.children?.[0]?.path ?? '/dashboard';

  const renderHub = (h: NavHub) => {
    const active = activeHub?.id === h.id;
    return (
      <NavLink
        key={h.id}
        to={hubTarget(h)}
        onClick={onNavigate}
        title={collapsed ? t(h.labelKey, h.label) : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          collapsed && 'justify-center px-0',
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
        )}
      >
        <span
          className={cn(
            'absolute inset-y-1 start-0 w-0.5 rounded-full bg-primary transition-opacity',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
        <h.icon className="h-5 w-5 shrink-0" />
        {!collapsed && <span className="truncate">{t(h.labelKey, h.label)}</span>}
      </NavLink>
    );
  };

  return (
    <aside
      className={cn(
        'flex h-screen flex-col border-e border-border bg-surface transition-[width] duration-base',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      {/* Brand + collapse toggle */}
      <div
        className={cn(
          'flex shrink-0 items-center border-b border-border py-4',
          collapsed ? 'justify-center px-3' : 'gap-2.5 px-5',
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary-hover shadow-sm">
          <span className="text-sm font-bold text-primary-foreground">M</span>
        </div>
        {!collapsed && (
          <>
            <span className="flex-1 truncate font-display text-base font-semibold text-foreground">
              {t('login.title')}
            </span>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand sidebar"
          className="mx-auto mt-2 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}

      {/* Primary hub rail */}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {mainHubs.map(renderHub)}
      </nav>

      {/* Settings (gear) + user + logout */}
      <div className="shrink-0 space-y-1 border-t border-border px-3 py-3">
        {settingsHub && renderHub(settingsHub)}
        <div
          className={cn(
            'flex items-center rounded-lg py-1.5',
            collapsed ? 'justify-center px-0' : 'gap-3 px-2',
          )}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <span className="text-sm font-semibold text-primary">
              {user?.firstName?.[0]}
              {user?.lastName?.[0]}
            </span>
          </div>
          {!collapsed && (
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
          )}
        </div>
        <button
          onClick={logout}
          title={collapsed ? t('nav.logout') : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors',
            'hover:bg-danger-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            collapsed && 'justify-center px-0',
          )}
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && t('nav.logout')}
        </button>
        {!collapsed && (
          <p className="select-text pt-1 text-center text-[10px] text-muted-foreground">
            {APP_VERSION}
          </p>
        )}
      </div>
    </aside>
  );
}
