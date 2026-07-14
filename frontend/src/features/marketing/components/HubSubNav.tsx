import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { NAV_HUBS, visibleNav, findActiveHub } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { cn } from '../../../components/ui/cn';

/**
 * Secondary navigation for the active hub — a horizontal tab strip of the hub's
 * sibling pages (GoHighLevel sub-tabs). Renders nothing for single-page hubs
 * (Dashboard/Tasks) or the Settings area (which has its own layout). Gating
 * mirrors the sidebar, so only visible children show.
 */
export default function HubSubNav() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const { has } = useEntitlements();
  const { isAgency } = useWorkspaceProfile();
  const location = useLocation();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const hubs = visibleNav(NAV_HUBS, { isManager, isOwner: user?.role === 'OWNER', has, isAgency });
  const active = findActiveHub(hubs, location.pathname);
  if (!active || active.area === 'settings' || !active.children || active.children.length < 2) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-surface px-4">
      {active.children.map((c) => (
        <NavLink
          key={c.path}
          to={c.path}
          // A hub "overview" path (e.g. /reports) is a prefix of its sub-tabs
          // (/reports/ads); `end` there keeps it from staying highlighted on them.
          end={active.children!.some((s) => s.path !== c.path && s.path.startsWith(c.path + '/'))}
          className="relative whitespace-nowrap px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {({ isActive }) => (
            <>
              <span className={isActive ? 'text-primary' : 'text-muted-foreground transition-colors hover:text-foreground'}>
                {t(c.labelKey, c.label)}
              </span>
              <span
                className={cn(
                  'absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary transition-opacity',
                  isActive ? 'opacity-100' : 'opacity-0',
                )}
              />
            </>
          )}
        </NavLink>
      ))}
    </div>
  );
}
