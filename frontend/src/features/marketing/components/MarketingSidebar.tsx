import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRightOnRectangleIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { APP_VERSION } from '../../../lib/env';
import { NAV_GROUPS, visibleNav, type NavItem } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary/10 text-primary'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  ].join(' ');

export default function MarketingSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { t } = useTranslation('marketing');
  const { user, logout } = useMarketingAuthStore();
  const { has } = useEntitlements();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // Collapsible groups (only Growth, today) remember their open state per group id.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Role + entitlement gated, with emptied groups already dropped.
  const groups = visibleNav(NAV_GROUPS, { isManager, has });

  const renderItem = (item: NavItem) => (
    <NavLink key={item.path} to={item.path} onClick={onNavigate} className={linkClass}>
      {({ isActive }) => (
        <>
          {/* Active accent bar — the primary wayfinding cue. */}
          <span
            className={`absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary transition-opacity ${
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
    <aside className="flex h-screen w-64 flex-col border-r border-slate-200 bg-white">
      {/* Brand */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-slate-200 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary-600 shadow-sm">
          <span className="text-sm font-bold text-primary-foreground">M</span>
        </div>
        <span className="font-heading text-base font-semibold text-slate-900">
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
                  className="flex w-full items-center justify-between px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-600"
                >
                  <span>{t(group.labelKey, group.label)}</span>
                  <ChevronDownIcon
                    className={`h-4 w-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  />
                </button>
              ) : (
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {t(group.labelKey, group.label)}
                </p>
              )}
              {!isCollapsed && items.map(renderItem)}
            </div>
          );
        })}
      </nav>

      {/* User card + logout */}
      <div className="shrink-0 border-t border-slate-200 px-3 py-3">
        <div className="mb-2 flex items-center gap-3 rounded-lg px-2 py-1.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            <span className="text-sm font-semibold text-primary">
              {user?.firstName?.[0]}
              {user?.lastName?.[0]}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="truncate text-xs text-slate-500">
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
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <ArrowRightOnRectangleIcon className="h-4 w-4" />
          {t('nav.logout')}
        </button>
        <p className="mt-2 select-text text-center text-[10px] text-slate-400">
          {APP_VERSION}
        </p>
      </div>
    </aside>
  );
}
