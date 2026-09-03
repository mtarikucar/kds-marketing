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
 * undifferentiated grab-bag.
 *
 * SEVEN groups over ~35 pages, down from nine over forty-two. Six pairs that
 * were one job each became one page each with deep-linkable tabs (Team+Roles,
 * Segments+Tags, the two Domains, the two Webhook directions, API keys+the
 * Claude connector, Voice+Phone tree), and two groups whose distinction nobody
 * navigates by were folded into their neighbours. Every old path still
 * resolves — App.tsx redirects each one to its tab — so the LIST got shorter
 * without anything becoming unreachable.
 *
 * Paths not listed fall into "Other" — which the test asserts stays EMPTY, so a
 * new settings page has to be placed on purpose.
 */
const SETTINGS_GROUPS: { key: string; label: string; paths: string[] }[] = [
  {
    key: 'workspace',
    label: 'Workspace',
    // What you configure once about the BUSINESS. /users is Team AND the roles
    // its members carry — one page, two tabs — because nobody thinks about a
    // role without thinking about the person who has it.
    paths: [
      '/branding',
      '/users',
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
    key: 'marketing',
    label: 'Marketing',
    /**
     * Everything you SET UP about marketing, whether it then runs itself or
     * waits to be drawn on.
     *
     * This was two groups — "Automation" and "Marketing assets" — and the line
     * between them did not survive contact with the list. A workflow runs
     * unattended and an email template does not, which is a true difference and
     * not one anybody navigates by: both answer "where do I go to change how we
     * market". Two four-item groups also cost more to scan than one of seven,
     * which is the whole reason this grouping exists.
     *
     * /settings/ai-models belongs here for its own reason: it is the model —
     * and therefore the PRICE PER CLIP — the content engine spends on when
     * nobody is watching.
     */
    paths: [
      '/studio/strategy',
      '/automations',
      '/settings/ai-models',
      '/trigger-links',
      '/email-templates',
      '/reviews',
      '/affiliates',
    ],
  },
  {
    key: 'channels',
    label: 'Channels & domains',
    /**
     * How the outside world reaches you and you reach it: the accounts you have
     * connected, the domains you own, and the telephone.
     *
     * Absorbed the standalone Telephony group. Its own note argued a call log
     * is "an operational record of work that already happened" and fitted no
     * other group — true of the LOG, and the group had since grown to hold
     * voice CONFIGURATION as well, which is plainly channel setup. With the
     * greeting and the phone tree now one page, what is left is the phone as a
     * channel, sitting with the other channels.
     *
     * /settings/domains is Sending + Website in one: both are a domain you own
     * and prove with DNS records, and which one it is depends only on what the
     * domain is FOR.
     */
    paths: ['/accounts', '/settings/domains', '/calls', '/voice'],
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
    // What SHAPES contact records rather than being contacts you work.
    // /segments is Segments AND Tags: a rule the system keeps applying and a
    // label somebody sticks on are two answers to one question, and the choice
    // between them is only visible when both are on the same page.
    paths: [
      '/settings/custom-fields',
      '/segments',
      '/import',
      '/research',
    ],
  },
  {
    key: 'developer',
    label: 'Developer & security',
    // /settings/api-keys is keys AND the Claude connector — both are granting
    // something outside this app the right to act inside it. /settings/webhooks
    // is outgoing AND inbound, which is one concept pointing two ways.
    paths: [
      '/settings/api-keys',
      '/settings/webhooks',
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
        {/*
          Named landmark. Without it this nav and the mobile strip below are two
          anonymous lists of the same links, and nothing — a screen reader or a
          browser test — can say which one it is looking at. The strip is
          `md:hidden` and this one `hidden md:flex`, so exactly one is on screen
          at a time, but only in a real browser: in jsdom both are "present".
        */}
        <nav
          aria-label={t('nav.group.settings', { defaultValue: 'Settings' })}
          className="min-h-0 flex-1 space-y-4 p-3"
        >
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
