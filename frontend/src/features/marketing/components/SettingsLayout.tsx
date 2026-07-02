import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { NAV_HUBS, visibleNav, type NavChild } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { cn } from '../../../components/ui/cn';

/**
 * Ordered sub-grouping for the Settings area, so the 17-item list reads as a few
 * labelled clusters (everyday admin up top; developer/compliance tooling last)
 * instead of one undifferentiated grab-bag. Paths not listed fall into "Other".
 */
const SETTINGS_GROUPS: { key: string; label: string; paths: string[] }[] = [
  { key: 'workspace', label: 'Workspace', paths: ['/branding', '/brand-kit', '/targets'] },
  { key: 'team', label: 'Team & access', paths: ['/users', '/settings/roles', '/settings/two-factor'] },
  { key: 'data', label: 'CRM data', paths: ['/settings/custom-fields', '/research'] },
  {
    key: 'integrations',
    label: 'Channels & integrations',
    paths: [
      '/settings/connections',
      '/settings/telephony',
      '/settings/voice-ai',
      '/settings/sending-domains',
      '/settings/custom-domains',
    ],
  },
  {
    key: 'developer',
    label: 'Developer',
    paths: ['/settings/api-keys', '/settings/webhooks', '/settings/inbound-webhooks'],
  },
  { key: 'compliance', label: 'Compliance', paths: ['/settings/compliance'] },
];

/**
 * The separate Settings area — a secondary vertical sidebar (desktop) / a
 * horizontal strip (mobile) listing the Settings hub's pages, plus a
 * "back to app" link. Wraps the routed settings page.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const { has } = useEntitlements();
  const { isAgency } = useWorkspaceProfile();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const hubs = visibleNav(NAV_HUBS, { isManager, has, isAgency });
  const items = hubs.find((h) => h.area === 'settings')?.children ?? [];

  // Bucket the visible settings items into ordered, labelled groups.
  const byPath = new Map(items.map((c) => [c.path, c]));
  const grouped = SETTINGS_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: g.paths
      .map((p) => byPath.get(p))
      .filter((c): c is NavChild => !!c),
  })).filter((g) => g.items.length > 0);
  const known = new Set(SETTINGS_GROUPS.flatMap((g) => g.paths));
  const other = items.filter((c) => !known.has(c.path));
  if (other.length) grouped.push({ key: 'other', label: 'Other', items: other });

  const vItem = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      isActive
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
    );

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Desktop secondary sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-e border-border bg-surface md:flex">
        <div className="border-b border-border px-4 py-4">
          <NavLink
            to="/dashboard"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('settings.backToApp', { defaultValue: 'Back to app' })}
          </NavLink>
          <h2 className="mt-3 font-display text-h3 text-foreground">
            {t('nav.group.settings', { defaultValue: 'Settings' })}
          </h2>
        </div>
        <nav className="min-h-0 flex-1 space-y-4 p-3">
          {grouped.map((g) => (
            <div key={g.key} className="space-y-1">
              <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(`settingsGroup.${g.key}`, g.label)}
              </p>
              {g.items.map((c) => (
                <NavLink key={c.path} to={c.path} className={vItem}>
                  {c.icon && <c.icon className="h-4 w-4 shrink-0" />}
                  <span className="truncate">{t(c.labelKey, c.label)}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile horizontal strip */}
      <div className="border-b border-border bg-surface md:hidden">
        <div className="flex items-center gap-1 overflow-x-auto px-4">
          {items.map((c) => (
            <NavLink
              key={c.path}
              to={c.path}
              className={({ isActive }) =>
                cn(
                  'relative whitespace-nowrap px-3 py-2.5 text-sm font-medium',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              {t(c.labelKey, c.label)}
            </NavLink>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
