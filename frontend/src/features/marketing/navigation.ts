import type { LucideIcon } from 'lucide-react';
import {
  Home,
  Users,
  ClipboardList,
  Calendar,
  FileText,
  BarChart3,
  DollarSign,
  Wrench,
  Phone,
  Flag,
  Target,
  FlaskConical,
  CreditCard,
  Sparkles,
  BookOpen,
  Inbox,
  Zap,
  Mail,
  Globe,
  CalendarDays,
  Mic,
  Banknote,
  Palette,
  SlidersHorizontal,
  Blocks,
  Tag,
  Filter,
  FileUp,
  GraduationCap,
  Building2,
  Camera,
  Receipt,
  Package,
  Repeat,
  ShoppingCart,
  KeyRound,
  Webhook,
  Plug,
  ListTree,
  ShieldCheck,
  Scale,
  Settings,
  Link2,
} from 'lucide-react';

/**
 * Single source of truth for the workspace console's navigation.
 *
 * 2026-07 IA simplification (user-driven): the previous 16-hub / ~70-page tree
 * still read as "everything piled up", so related pages were MERGED into
 * single tabbed surfaces and the tree cut to 9 core + 5 advanced hubs:
 *   - Reports: 4 pages → ONE /reports with tabs
 *   - Sales documents: Offers + Estimates + Documents → ONE /documents hub
 *   - Dialer folded into /calls; Tax Rates + Coupons folded into /products
 *   - Conversations hub dissolved — /inbox hosts Channels / Canned Responses /
 *     AI Agents / Knowledge as tabs
 *   - The AI hub is GONE: content tools live in Growth Studio's Create tab,
 *     conversation AI lives in the Inbox, brand voice lives in the Brand page
 *   - Brand: Branding + Brand Kit + Brand Brain → ONE /branding with tabs
 *   - Account Center absorbed Settings→Connections (one connections surface)
 * Old standalone routes were removed (clean cut), so every destination has
 * exactly one home.
 *
 * Gating is per-child (and per-hub): `managerOnly` items show only to
 * OWNER/MANAGER; `feature` items only when the workspace is entitled
 * (see {@link useEntitlements}); the Agency hub only renders for an AGENCY
 * workspace. Empty hubs (all children gated out) drop from the menu.
 */

/** Entitlement keys the backend's EntitlementsService exposes (subset used in nav). */
export type FeatureKey =
  | 'telephony'
  | 'installations'
  | 'commissions'
  | 'conversationAi'
  | 'workflows'
  | 'campaigns'
  | 'funnels'
  | 'reviews'
  | 'askAi'
  | 'agentStudio'
  | 'voiceAi'
  | 'invoicing'
  // Optional modules hidden by default for NEW workspaces (leaner first-run;
  // switch on in Modules). Existing workspaces (activatedModules null) keep them.
  | 'memberships'
  | 'research'
  // Platform-level inert features (env-gated; surfaced via /billing/summary so the
  // nav hides them until ops enables the feature, instead of showing a 503 button).
  | 'prospecting'
  | 'sendingDomains'
  | 'customDomains';

type IconType = LucideIcon;

export interface NavChild {
  path: string;
  /** i18n key; `label` is the inline fallback so a missing translation still reads well. */
  labelKey: string;
  label: string;
  icon?: IconType;
  /** When set, the child is hidden unless the workspace is entitled to this feature. */
  feature?: FeatureKey;
  /** When true, only OWNER/MANAGER see it. */
  managerOnly?: boolean;
}

export interface NavHub {
  id: string;
  labelKey: string;
  label: string;
  icon: IconType;
  /** Single-page hub (no sub-nav) lands here, e.g. Dashboard / Tasks. */
  path?: string;
  /** Sub-nav items (the pages this hub groups). */
  children?: NavChild[];
  /** Hub-level gating (single-page hubs); children carry their own gating. */
  feature?: FeatureKey;
  managerOnly?: boolean;
  /** Whole hub only renders for an AGENCY workspace (Epic D). */
  agencyOnly?: boolean;
  /** 'settings' hubs render in the separate Settings area (gear), not the primary rail. */
  area?: 'main' | 'settings';
  /**
   * Progressive-disclosure tier for main-area hubs. 'core' (default) is always
   * in the rail; 'advanced' is tucked behind a collapsed "More" section so the
   * default view stays focused. Nothing is removed — the command palette and the
   * "More" section still reach every advanced hub.
   */
  tier?: 'core' | 'advanced';
}

export const NAV_HUBS: NavHub[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', label: 'Dashboard', icon: Home, path: '/dashboard' },
  {
    // Single-page hub: channels / canned responses / AI agents / knowledge are
    // tabs INSIDE the inbox now (`/inbox?tab=…`), not sibling pages.
    id: 'inbox', labelKey: 'nav.inbox', label: 'Inbox', icon: Inbox,
    path: '/inbox', feature: 'conversationAi',
  },
  {
    id: 'contacts', labelKey: 'nav.group.contacts', label: 'Contacts', icon: Users,
    children: [
      { path: '/leads', labelKey: 'nav.leads', label: 'Leads', icon: Users },
      { path: '/companies', labelKey: 'nav.companies', label: 'Companies', icon: Building2 },
      { path: '/segments', labelKey: 'nav.segments', label: 'Segments', icon: Filter, managerOnly: true },
      { path: '/tags', labelKey: 'nav.tags', label: 'Tags', icon: Tag, managerOnly: true },
      { path: '/import', labelKey: 'nav.import', label: 'Import', icon: FileUp, managerOnly: true },
    ],
  },
  {
    id: 'sales', labelKey: 'nav.group.sales', label: 'Sales', icon: DollarSign,
    children: [
      { path: '/opportunities', labelKey: 'nav.opportunities', label: 'Pipeline', icon: Target },
      // Offers + Estimates + Documents merged into one tabbed hub.
      { path: '/documents', labelKey: 'nav.documents', label: 'Documents', icon: FileText },
      // Power Dialer is a tab inside Calls now.
      { path: '/calls', labelKey: 'nav.calls', label: 'Calls', icon: Phone, feature: 'telephony' },
      { path: '/prospecting', labelKey: 'nav.prospecting', label: 'Prospecting', icon: Globe, feature: 'prospecting' },
      { path: '/commissions', labelKey: 'nav.commissions', label: 'Commissions', icon: DollarSign, feature: 'commissions' },
      { path: '/installations', labelKey: 'nav.installations', label: 'Installations', icon: Wrench, feature: 'installations' },
    ],
  },
  {
    id: 'calendar', labelKey: 'nav.group.calendar', label: 'Calendar', icon: Calendar,
    children: [
      { path: '/calendar', labelKey: 'nav.calendar', label: 'Calendar', icon: Calendar },
      { path: '/booking', labelKey: 'nav.booking', label: 'Booking', icon: CalendarDays, feature: 'funnels', managerOnly: true },
      { path: '/appointments', labelKey: 'nav.appointments', label: 'Appointments', icon: CalendarDays, feature: 'funnels', managerOnly: true },
    ],
  },
  { id: 'tasks', labelKey: 'nav.tasks', label: 'Tasks', icon: ClipboardList, path: '/tasks' },
  {
    // The unified Growth Studio — content calendar, Create (AI content +
    // personas), campaigns (normal + social + planner), trends and the
    // Autopilot as deep-linkable tabs (`/studio?tab=…&sub=…`) on one page.
    // CORE tier: the product's flagship surface. Managers only (real spend).
    id: 'studio', labelKey: 'nav.studio', label: 'Growth Studio', icon: Sparkles,
    path: '/studio', managerOnly: true, tier: 'core',
  },
  {
    // Single-page hub: Ads / Performance / Analytics are tabs inside /reports.
    id: 'reports', labelKey: 'nav.reports', label: 'Reports', icon: BarChart3, path: '/reports',
  },
  { id: 'help', labelKey: 'nav.help', label: 'Help', icon: BookOpen, path: '/help' },

  // ——— advanced (behind "More") ———
  {
    id: 'automation', labelKey: 'nav.group.automation', label: 'Automation', icon: Zap, tier: 'advanced',
    children: [
      { path: '/automations', labelKey: 'nav.automations', label: 'Workflows', icon: Zap, feature: 'workflows', managerOnly: true },
      { path: '/trigger-links', labelKey: 'nav.triggerLinks', label: 'Trigger Links', icon: Link2, managerOnly: true },
    ],
  },
  {
    id: 'payments', labelKey: 'nav.group.payments', label: 'Payments', icon: Banknote, tier: 'advanced',
    children: [
      // Tax Rates + Coupons are tabs inside Products now.
      { path: '/products', labelKey: 'nav.products', label: 'Products', icon: Package, managerOnly: true },
      { path: '/subscriptions', labelKey: 'nav.subscriptions', label: 'Subscriptions', icon: Repeat, managerOnly: true },
      { path: '/order-forms', labelKey: 'nav.orderForms', label: 'Order forms', icon: ShoppingCart, managerOnly: true },
      { path: '/invoices', labelKey: 'nav.invoices', label: 'Invoices', icon: Banknote, feature: 'invoicing', managerOnly: true },
      { path: '/billing', labelKey: 'nav.billing', label: 'Billing', icon: CreditCard, managerOnly: true },
    ],
  },
  {
    // Surveys + A/B Experiments were deleted (2026-07 trim: dead-end surfaces —
    // no respondent renderer / no variant consumer ever existed).
    id: 'sites', labelKey: 'nav.sites', label: 'Sites & Funnels', icon: Globe, tier: 'advanced',
    path: '/sites', feature: 'funnels', managerOnly: true,
  },
  {
    // Communities + Leaderboard were deleted (2026-07 trim: they simulated a
    // member experience no member could ever see — no member portal exists).
    // Module OFF by default for new workspaces (feature 'memberships'); existing
    // workspaces (activatedModules null) keep it. Switch on in Modules.
    id: 'memberships', labelKey: 'nav.courses', label: 'Courses', icon: GraduationCap, tier: 'advanced',
    path: '/memberships/courses', managerOnly: true, feature: 'memberships',
  },
  {
    id: 'voice', labelKey: 'nav.group.voice', label: 'Voice', icon: Mic, tier: 'advanced',
    children: [
      { path: '/voice', labelKey: 'nav.voice', label: 'Voice', icon: Mic, feature: 'voiceAi', managerOnly: true },
      { path: '/voice/ivr', labelKey: 'nav.ivr', label: 'Phone Tree', icon: ListTree, feature: 'voiceAi', managerOnly: true },
    ],
  },
  {
    id: 'agency', labelKey: 'nav.group.agency', label: 'Agency', icon: Building2, agencyOnly: true, tier: 'advanced',
    children: [
      { path: '/agency/locations', labelKey: 'nav.agencyLocations', label: 'Sub-accounts', icon: Building2, managerOnly: true },
      { path: '/agency/snapshots', labelKey: 'nav.agencySnapshots', label: 'Snapshots', icon: Camera, managerOnly: true },
      { path: '/agency/rebilling', labelKey: 'nav.agencyRebilling', label: 'Rebilling', icon: Receipt, managerOnly: true },
    ],
  },
  {
    id: 'settings', labelKey: 'nav.group.settings', label: 'Settings', icon: Settings, area: 'settings',
    children: [
      // Workspace
      { path: '/branding', labelKey: 'nav.brand', label: 'Brand', icon: Palette, managerOnly: true },
      { path: '/users', labelKey: 'nav.users', label: 'Team', icon: Users, managerOnly: true },
      { path: '/settings/roles', labelKey: 'nav.roles', label: 'Roles & permissions', icon: ShieldCheck, managerOnly: true },
      { path: '/targets', labelKey: 'nav.targets', label: 'Targets', icon: Flag, managerOnly: true },
      { path: '/settings/modules', labelKey: 'nav.modules', label: 'Modules', icon: Blocks, managerOnly: true },
      // Data (Custom Objects deleted — 2026-07 trim: an island with no consumer
      // anywhere and no record-to-contact linking UI at all)
      { path: '/settings/custom-fields', labelKey: 'nav.customFields', label: 'Custom Fields', icon: SlidersHorizontal, managerOnly: true },
      { path: '/research', labelKey: 'nav.research', label: 'Research', icon: FlaskConical, managerOnly: true, feature: 'research' },
      // Connections & domains (Account Center absorbed Settings→Connections)
      { path: '/accounts', labelKey: 'nav.accounts', label: 'Connections', icon: Plug, managerOnly: true },
      { path: '/settings/sending-domains', labelKey: 'nav.sendingDomains', label: 'Sending Domains', icon: Mail, managerOnly: true, feature: 'sendingDomains' },
      { path: '/settings/custom-domains', labelKey: 'nav.customDomains', label: 'Custom Domains', icon: Globe, managerOnly: true, feature: 'customDomains' },
      // Developer & security
      { path: '/settings/api-keys', labelKey: 'nav.apiKeys', label: 'API Keys', icon: KeyRound, managerOnly: true },
      { path: '/settings/webhooks', labelKey: 'nav.webhooks', label: 'Webhooks', icon: Webhook, managerOnly: true },
      { path: '/settings/inbound-webhooks', labelKey: 'nav.inboundWebhooks', label: 'Inbound webhooks', icon: Webhook, managerOnly: true },
      { path: '/settings/compliance', labelKey: 'nav.compliance', label: 'Compliance', icon: Scale, managerOnly: true },
      { path: '/settings/two-factor', labelKey: 'nav.twoFactor', label: 'Two-factor auth', icon: ShieldCheck },
    ],
  },
];

export interface NavVisibilityOpts {
  isManager: boolean;
  /** Entitlement check; `has(undefined)` is true (core item). */
  has: (feature?: FeatureKey) => boolean;
  /** True only for an AGENCY workspace — gates the `agencyOnly` hub (Epic D). */
  isAgency?: boolean;
}

function childVisible(c: NavChild, opts: NavVisibilityOpts): boolean {
  return (c.managerOnly ? opts.isManager : true) && opts.has(c.feature);
}

/**
 * Filter hubs for the current user: drop agency-only hubs for non-agency
 * workspaces; filter each hub's children by role/entitlement; drop a hub that
 * ends up with no visible children AND no own `path` (single-page hub).
 * Pure (no rendering) so it stays unit-testable. Same gating semantics as the
 * old flat menu — only the shape (hubs) changed.
 */
export function visibleNav(hubs: NavHub[], opts: NavVisibilityOpts): NavHub[] {
  return hubs
    .filter((h) => (h.agencyOnly ? !!opts.isAgency : true))
    .map((h) => {
      if (!h.children) return h; // single-page hub
      return { ...h, children: h.children.filter((c) => childVisible(c, opts)) };
    })
    .filter((h) => (h.children ? h.children.length > 0 : !!h.path) &&
      (h.managerOnly ? opts.isManager : true) && opts.has(h.feature));
}

/**
 * Split already-visible MAIN-area hubs into `core` (always in the rail) and
 * `advanced` (tucked behind the collapsed "More" section). Settings-area hubs
 * are excluded — they render in the gear area, not the primary rail. Pure so it
 * stays unit-testable.
 */
export function splitByTier(hubs: NavHub[]): { core: NavHub[]; advanced: NavHub[] } {
  const main = hubs.filter((h) => (h.area ?? 'main') === 'main');
  return {
    core: main.filter((h) => (h.tier ?? 'core') === 'core'),
    advanced: main.filter((h) => h.tier === 'advanced'),
  };
}

/** All routable paths a hub owns (its own `path` + every child path). */
function hubPaths(h: NavHub): string[] {
  const paths = h.children ? h.children.map((c) => c.path) : [];
  if (h.path) paths.push(h.path);
  return paths;
}

/**
 * Resolve which hub owns the current route: the hub containing the path that is
 * the longest match for `pathname` (exact, or a parent of a detail route like
 * `/leads/123` → `/leads`). Each routable path belongs to exactly one hub, so
 * the match is unambiguous. Returns undefined if nothing matches.
 */
export function findActiveHub(hubs: NavHub[], pathname: string): NavHub | undefined {
  let best: { hub: NavHub; len: number } | undefined;
  for (const h of hubs) {
    for (const p of hubPaths(h)) {
      if (pathname === p || pathname.startsWith(p + '/')) {
        if (!best || p.length > best.len) best = { hub: h, len: p.length };
      }
    }
  }
  return best?.hub;
}
