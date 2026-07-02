import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut, PanelLeftClose, PanelLeft, Star, ChevronRight } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useSidebarPrefsStore } from '../../../store/sidebarPrefsStore';
import { APP_VERSION } from '../../../lib/env';
import { NAV_HUBS, visibleNav, findActiveHub, splitByTier, type NavHub } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { cn } from '../../../components/ui/cn';

const STORAGE_KEY = 'kds-sidebar-collapsed';

/**
 * Primary navigation rail — a lean list of GoHighLevel-style HUBS grouped for
 * progressive disclosure: the user's PINNED hubs first, then the CORE tier, then
 * an ADVANCED tier tucked behind a collapsed "More" disclosure. Nothing is
 * removed — "More" and the command palette (Cmd/Ctrl+K) still reach every hub —
 * but the default view stays focused (~6-8 items) instead of ~15. Settings is
 * pinned at the bottom as a gear. Collapses to an icon-rail (persisted).
 */
export default function MarketingSidebar({
  onNavigate,
  forceExpanded = false,
}: { onNavigate?: () => void; forceExpanded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const { user, logout } = useMarketingAuthStore();
  const { has } = useEntitlements();
  const { isAgency } = useWorkspaceProfile();
  const location = useLocation();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const favorites = useSidebarPrefsStore((s) => s.favorites);
  const toggleFavorite = useSidebarPrefsStore((s) => s.toggleFavorite);
  const advancedOpen = useSidebarPrefsStore((s) => s.advancedOpen);
  const setAdvancedOpen = useSidebarPrefsStore((s) => s.setAdvancedOpen);

  const [collapsedPref, setCollapsedPref] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  // Inside the mobile drawer we always render expanded (labels visible),
  // regardless of the persisted desktop-collapsed preference.
  const collapsed = forceExpanded ? false : collapsedPref;
  const toggleCollapsed = () =>
    setCollapsedPref((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });

  const hubs = visibleNav(NAV_HUBS, { isManager, has, isAgency });
  const settingsHub = hubs.find((h) => h.area === 'settings');
  const activeHub = findActiveHub(hubs, location.pathname);

  const { core, advanced } = splitByTier(hubs);
  const isPinned = (h: NavHub) => favorites.includes(h.id);
  const pinned = [...core, ...advanced].filter(isPinned);
  const coreRest = core.filter((h) => !isPinned(h));
  const advancedRest = advanced.filter((h) => !isPinned(h));
  // Auto-open "More" when the user NAVIGATES into an advanced page (keyed on the
  // active hub id, so a later manual collapse is respected instead of snapping
  // back open). The section is then driven purely by `advancedOpen`, so the
  // toggle always does something.
  const activeInAdvanced = !!activeHub && advancedRest.some((h) => h.id === activeHub.id);
  const activeHubId = activeHub?.id;
  useEffect(() => {
    if (activeInAdvanced) setAdvancedOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHubId]);

  const hubTarget = (h: NavHub) => h.path ?? h.children?.[0]?.path ?? '/dashboard';

  const renderHub = (h: NavHub, opts?: { pinnable?: boolean }) => {
    const pinnable = opts?.pinnable ?? true;
    const active = activeHub?.id === h.id;
    const pinnedNow = isPinned(h);
    return (
      <div key={h.id} className="group relative">
        <NavLink
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
        {!collapsed && pinnable && (
          <button
            type="button"
            onClick={() => toggleFavorite(h.id)}
            aria-label={pinnedNow ? t('nav.unpin', 'Unpin') : t('nav.pin', 'Pin')}
            aria-pressed={pinnedNow}
            className={cn(
              'absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-opacity',
              'focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              pinnedNow
                ? 'text-primary opacity-100'
                : // hidden until hover/focus — pointer-events-none so an invisible
                  // star is never an accidental tap target (esp. in the touch drawer)
                  'text-muted-foreground opacity-0 pointer-events-none hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto',
            )}
          >
            <Star className={cn('h-3.5 w-3.5', pinnedNow && 'fill-current')} />
          </button>
        )}
      </div>
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
            {!forceExpanded && (
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Collapse sidebar"
                className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            )}
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
        {collapsed ? (
          // Icon rail: flat list, no section chrome.
          [...pinned, ...coreRest, ...advancedRest].map((h) => renderHub(h))
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="space-y-1 pb-1">
                <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('nav.pinned', 'Pinned')}
                </p>
                {pinned.map((h) => renderHub(h))}
              </div>
            )}
            {coreRest.map((h) => renderHub(h))}
            {advancedRest.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  aria-expanded={advancedOpen}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      (advancedOpen) && 'rotate-90',
                    )}
                  />
                  {t('nav.more', 'More')}
                </button>
                {(advancedOpen) && (
                  <div className="mt-1 space-y-1">{advancedRest.map((h) => renderHub(h))}</div>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Settings (gear) + user + logout */}
      <div className="shrink-0 space-y-1 border-t border-border px-3 py-3">
        {settingsHub && renderHub(settingsHub, { pinnable: false })}
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
