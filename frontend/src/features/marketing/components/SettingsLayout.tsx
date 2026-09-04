import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { NAV_HUBS, visibleNav, type NavChild } from '../navigation';
import { useEntitlements } from '../hooks/useEntitlements';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { cn } from '../../../components/ui/cn';

/**
 * Ordered sub-grouping for the Settings area.
 *
 * SEVEN groups over SEVENTEEN pages, from nine over forty-two two days ago. The
 * cut was not "put things in better boxes" — it was noticing how many entries
 * were one job filed under two or four names, and how many were filed in
 * Settings at all when their effect is only visible somewhere else.
 *
 * Three left entirely: importing people, grouping them, and defining what a
 * record can hold are all about the people in the INBOX, and living here put
 * them a whole surface away from the only place you can see them work.
 *
 * Every absorbed path still resolves — App.tsx redirects each to its tab, and
 * the command palette offers each by its own name. Paths not listed fall into
 * "Other", which the test asserts stays EMPTY, so a new settings page has to be
 * placed on purpose.
 */
const SETTINGS_GROUPS: { key: string; label: string; paths: string[] }[] = [
  {
    key: 'workspace',
    label: 'Your business',
    /**
     * What somebody opening a new workspace has to fill in before anything else
     * works, and rarely touches again: who this business IS, and who works here.
     *
     * Two pages, not seven. `/branding` carries the identity, the visual kit,
     * the AI brand voice AND the deal stages — all four are "the shape of the
     * business". `/users` carries the members, what they may do, what they are
     * aiming at and when they can be booked — all four are about PEOPLE, and
     * three of them used to be findable only if you already knew they were not
     * on the page about people.
     */
    paths: ['/branding', '/users'],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    /**
     * `/studio/strategy` is first and always will be: a workspace without a
     * strategy is not one with a blank page, it is one whose automations have
     * nothing to be FOR. The machinery that serves it — the workflows, and the
     * research that feeds them — are tabs of it rather than siblings.
     *
     * "AI research" stopped being its own entry because nobody could state its
     * difference from an automation: both are standing instructions that run
     * without you and put data into the funnel.
     *
     * Sites & funnels moved in from workspace setup. A funnel is not something
     * you configure once about the business; it is a thing you build to market
     * with, and it belongs with the other things you build to market with.
     */
    paths: [
      '/studio/strategy',
      '/sites',
      '/email-templates',
      '/settings/ai-models',
      '/reviews',
      '/trigger-links',
      '/affiliates',
      '/memberships/courses',
    ],
  },
  {
    key: 'selling',
    label: 'Selling',
    // One page, in the order a sale happens: a product is what you sell, an
    // order form is how somebody buys it, a subscription is what recurs, an
    // invoice is what gets paid — and the payment provider that settles it.
    paths: ['/products'],
  },
  {
    key: 'channels',
    label: 'Channels & domains',
    // How the outside world reaches you and you reach it. `/voice` is now the
    // whole telephone: what answers it, the options it offers, and what it did.
    paths: ['/accounts', '/settings/domains', '/voice'],
  },
  {
    key: 'developer',
    label: 'Developer & security',
    paths: [
      '/settings/api-keys',
      '/settings/webhooks',
      '/settings/compliance',
      '/settings/two-factor',
    ],
  },
  {
    key: 'plan',
    label: 'Plan & access',
    // LAST, deliberately. Modules used to sit near the top, which put a switch
    // that REMOVES features next to the logo and the timezone. It belongs with
    // the plan that pays for them, at the end, where you go once.
    paths: ['/billing'],
  },
  {
    key: 'agency',
    label: 'Agency',
    // Invisible to everyone but an AGENCY workspace's owner (the gating rides
    // on the items themselves — see navigation.ts).
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
