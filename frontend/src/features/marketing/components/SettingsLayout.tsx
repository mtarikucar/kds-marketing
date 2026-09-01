import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { NAV_HUBS, visibleNav, type NavChild } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { cn } from '../../../components/ui/cn';

/**
 * Ordered sub-grouping for the Settings area, so the list reads as everyday
 * admin up top and developer/compliance tooling last instead of one
 * undifferentiated grab-bag. Brand is ONE page now (kit + brain are tabs inside
 * /branding) and the Account Center is THE connections surface.
 *
 * Grew from four clusters to seven with the 2026-08 surface merge: the retired
 * Strategy / Automation / Payments / Sites / Courses / Agency hubs landed here,
 * and thirteen unclustered pages would have made this exactly the grab-bag the
 * grouping exists to prevent. An eighth arrived with the call log on
 * 2026-08-31 — see the Telephony entry for why it is its own cluster rather
 * than an exception inside someone else's. Paths not listed fall into "Other"
 * — which the test asserts stays EMPTY, so a new settings page has to be
 * placed on purpose.
 */
const SETTINGS_GROUPS: { key: string; label: string; paths: string[] }[] = [
  {
    key: 'workspace',
    label: 'Workspace',
    // /booking configures the public booking page — workspace setup. The
    // appointments it produces stay in the Inbox surface, alongside the
    // calendar they land on.
    paths: [
      '/branding',
      '/users',
      '/settings/roles',
      '/targets',
      // Pipelines sits beside Targets rather than in a group of its own: both
      // are the sales SHAPE a manager defines once (the stages a deal moves
      // through, the numbers it is measured against) and everybody then works
      // inside. Filing it under Data would make that group mean "what shapes
      // contact records, and also deals".
      '/settings/pipelines',
      '/settings/modules',
      '/booking',
      // Public surfaces you configure once, absorbed from the Sites and
      // Courses hubs — they are workspace setup, not somewhere you work daily.
      '/sites',
      '/memberships/courses',
    ],
  },
  {
    key: 'automation',
    label: 'Automation',
    // Set-and-forget machinery, absorbed from the Strategy and Automation hubs:
    // you configure the plan, the system runs it without you.
    paths: ['/studio/strategy', '/automations', '/trigger-links'],
  },
  {
    key: 'marketing',
    label: 'Marketing assets',
    /**
     * The three pages that lost their hiding place when Growth Studio collapsed
     * into one working screen (2026-08). They were sub-tabs of a "More" tab
     * inside a mode you had to know to open; now they have a home.
     *
     * Their own group, for the reason the Telephony note below gives at length.
     * Workspace is what you configure once about the BUSINESS; Automation is
     * machinery that runs without you; Products & billing is what you sell.
     * These three are none of those: they are the reusable assets the outbound
     * side draws on — the template library a campaign sends from, the
     * review-request setup, the partner programme. Filing them under Workspace
     * would make that group mean "and also some marketing", which is exactly
     * how the grab-bag this grouping exists to prevent gets rebuilt.
     */
    paths: ['/email-templates', '/reviews', '/affiliates'],
  },
  {
    key: 'telephony',
    label: 'Telephony',
    /**
     * The call log, moved out of the Inbox surface (see navigation.ts) — and
     * given a group of its own rather than folded into one of the seven that
     * already existed.
     *
     * None of them is honest about it. Workspace is what you configure once;
     * Automation is machinery that runs without you; Products & billing is
     * what you sell; Data is what SHAPES contact records; Connections &
     * domains is external plumbing; Developer & security is tooling; Agency is
     * the sub-account console. A call log is an operational record of work
     * that already happened, and filing it under any of those would make that
     * group mean "and also calls" — which is how the grab-bag this grouping
     * exists to prevent gets rebuilt one exception at a time.
     *
     * That day was 2026-09-01. /voice and /voice/ivr joined it in stage 4 of
     * the one-screen brief, for a reason next to the log's rather than the same
     * one: those two are channel CONFIGURATION — record a greeting, wire a menu
     * of options, leave it running — and nothing you configure once arrives
     * with a person attached, which is what the Inbox surface is for. The group
     * now reads as the whole telephone: what you set up, and what it did.
     */
    paths: ['/calls', '/voice', '/voice/ivr'],
  },
  {
    key: 'billing',
    label: 'Products & billing',
    // Absorbed from the Payments hub — what you sell and how you get paid.
    paths: ['/products', '/subscriptions', '/order-forms', '/invoices', '/billing'],
  },
  {
    key: 'data',
    label: 'Data',
    // Segments/Tags/Import moved here from the Contacts hub (2026-08 rail cut):
    // they SHAPE contact data rather than being contacts you work, which is
    // the same reason Custom Fields already lived here.
    paths: [
      '/settings/custom-fields',
      '/custom-objects',
      '/research',
      '/segments',
      '/tags',
      '/import',
    ],
  },
  {
    key: 'connections',
    label: 'Connections & domains',
    paths: ['/accounts', '/settings/sending-domains', '/settings/custom-domains'],
  },
  {
    key: 'developer',
    label: 'Developer & security',
    paths: [
      '/settings/api-keys',
      '/settings/mcp-console',
      '/settings/webhooks',
      '/settings/inbound-webhooks',
      '/settings/compliance',
      '/settings/two-factor',
    ],
  },
  {
    key: 'agency',
    label: 'Agency',
    // Last, and invisible to everyone but an AGENCY workspace's owner (the
    // gating rides on the items themselves — see navigation.ts).
    paths: ['/agency/locations', '/agency/snapshots', '/agency/rebilling'],
  },
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

  // isOwner matters here now: the Agency console's three pages moved INTO this
  // area (2026-08 surface merge) carrying their ownerOnly gate as items.
  const hubs = visibleNav(NAV_HUBS, {
    isManager, isOwner: user?.role === 'OWNER', has, isAgency,
  });
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
            to="/home"
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
