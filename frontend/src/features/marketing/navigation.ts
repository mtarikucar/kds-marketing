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
  LineChart,
  PieChart,
  Flag,
  Target,
  FlaskConical,
  CreditCard,
  Sparkles,
  BookOpen,
  Inbox,
  MessagesSquare,
  Zap,
  Megaphone,
  Mail,
  Globe,
  CalendarDays,
  Star,
  Mic,
  Banknote,
  Palette,
  SlidersHorizontal,
  Tag,
  Filter,
  FileUp,
  GraduationCap,
  Trophy,
  Building2,
  Camera,
  Receipt,
  Package,
  Repeat,
  ShoppingCart,
  KeyRound,
  Webhook,
  Plug,
  Share2,
  ListTree,
  ShieldCheck,
  Lock,
  Scale,
  BadgeDollarSign,
  Settings,
  PhoneCall,
  MousePointerClick,
  Database,
  MessageSquareText,
  Link2,
  Percent,
  Ticket,
} from 'lucide-react';

/**
 * Single source of truth for the workspace console's navigation — a **two-level
 * GoHighLevel-style hub model**.
 *
 * The flat ~47-item menu (Growth had 16, Settings 15) was overwhelming and
 * undiscoverable. Instead the primary sidebar is a lean list of HUBS; each hub
 * groups a few related pages shown as a secondary sub-nav, and Settings is a
 * separate area. Every page/route URL is unchanged — only the grouping changed.
 *
 * Gating is per-child (and per-hub): `managerOnly` items show only to
 * OWNER/MANAGER; `feature` items only when the workspace is entitled
 * (see {@link useEntitlements}); the Agency hub only renders for an AGENCY
 * workspace. Empty hubs (all children gated out) drop from the menu, so a
 * core-only workspace still sees a focused set.
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
}

export const NAV_HUBS: NavHub[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', label: 'Dashboard', icon: Home, path: '/dashboard' },
  {
    id: 'conversations', labelKey: 'nav.group.conversations', label: 'Conversations', icon: MessagesSquare,
    children: [
      { path: '/inbox', labelKey: 'nav.inbox', label: 'Inbox', icon: Inbox, feature: 'conversationAi' },
      { path: '/settings/snippets', labelKey: 'nav.snippets', label: 'Canned Responses', icon: MessageSquareText, feature: 'conversationAi', managerOnly: true },
      { path: '/channels', labelKey: 'nav.channels', label: 'Channels', icon: MessagesSquare, feature: 'conversationAi', managerOnly: true },
    ],
  },
  {
    id: 'contacts', labelKey: 'nav.group.contacts', label: 'Contacts', icon: Users,
    children: [
      { path: '/leads', labelKey: 'nav.leads', label: 'Leads', icon: Users },
      { path: '/companies', labelKey: 'nav.companies', label: 'Companies', icon: Building2 },
      { path: '/custom-objects', labelKey: 'nav.customObjects', label: 'Custom Objects', icon: Database, managerOnly: true },
      { path: '/settings/segments', labelKey: 'nav.segments', label: 'Segments', icon: Filter, managerOnly: true },
      { path: '/settings/tags', labelKey: 'nav.tags', label: 'Tags', icon: Tag, managerOnly: true },
      { path: '/settings/import', labelKey: 'nav.import', label: 'Import', icon: FileUp, managerOnly: true },
    ],
  },
  {
    id: 'calendar', labelKey: 'nav.group.calendar', label: 'Calendar', icon: Calendar,
    children: [
      { path: '/calendar', labelKey: 'nav.calendar', label: 'Calendar', icon: Calendar },
      { path: '/booking', labelKey: 'nav.booking', label: 'Booking', icon: CalendarDays, feature: 'funnels', managerOnly: true },
    ],
  },
  {
    id: 'sales', labelKey: 'nav.group.sales', label: 'Sales', icon: DollarSign,
    children: [
      { path: '/opportunities', labelKey: 'nav.opportunities', label: 'Opportunities', icon: Target },
      { path: '/estimates', labelKey: 'nav.estimates', label: 'Estimates', icon: Receipt },
      { path: '/documents', labelKey: 'nav.documents', label: 'Documents', icon: FileText },
      { path: '/offers', labelKey: 'nav.offers', label: 'Offers', icon: FileText },
      { path: '/calls', labelKey: 'nav.calls', label: 'Calls', icon: Phone, feature: 'telephony' },
      { path: '/dialer', labelKey: 'nav.dialer', label: 'Power Dialer', icon: PhoneCall, feature: 'telephony' },
      { path: '/prospecting', labelKey: 'nav.prospecting', label: 'Prospecting', icon: Globe, feature: 'prospecting' },
      { path: '/commissions', labelKey: 'nav.commissions', label: 'Commissions', icon: DollarSign, feature: 'commissions' },
      { path: '/installations', labelKey: 'nav.installations', label: 'Installations', icon: Wrench, feature: 'installations' },
    ],
  },
  { id: 'tasks', labelKey: 'nav.tasks', label: 'Tasks', icon: ClipboardList, path: '/tasks' },
  {
    id: 'marketing', labelKey: 'nav.group.marketing', label: 'Marketing', icon: Megaphone,
    children: [
      { path: '/campaigns', labelKey: 'nav.campaigns', label: 'Campaigns', icon: Megaphone, feature: 'campaigns', managerOnly: true },
      { path: '/email-templates', labelKey: 'nav.emailTemplates', label: 'Email Templates', icon: Mail, feature: 'campaigns', managerOnly: true },
      { path: '/social', labelKey: 'nav.social', label: 'Social Planner', icon: Share2, managerOnly: true },
      { path: '/trigger-links', labelKey: 'nav.triggerLinks', label: 'Trigger Links', icon: Link2, managerOnly: true },
      { path: '/reviews', labelKey: 'nav.reviews', label: 'Reviews', icon: Star, feature: 'reviews', managerOnly: true },
      { path: '/affiliates', labelKey: 'nav.affiliates', label: 'Affiliates', icon: BadgeDollarSign, feature: 'commissions', managerOnly: true },
    ],
  },
  {
    id: 'sites', labelKey: 'nav.group.sites', label: 'Sites', icon: Globe,
    children: [
      { path: '/sites', labelKey: 'nav.sites', label: 'Sites & Funnels', icon: Globe, feature: 'funnels', managerOnly: true },
      { path: '/surveys', labelKey: 'nav.surveys', label: 'Surveys', icon: ClipboardList, managerOnly: true },
      { path: '/experiments', labelKey: 'nav.experiments', label: 'A/B Experiments', icon: FlaskConical, managerOnly: true },
    ],
  },
  {
    id: 'automation', labelKey: 'nav.group.automation', label: 'Automation', icon: Zap,
    children: [
      { path: '/automations', labelKey: 'nav.automations', label: 'Workflows', icon: Zap, feature: 'workflows', managerOnly: true },
      { path: '/ai/agents', labelKey: 'nav.agentStudio', label: 'AI Agents', icon: Sparkles, feature: 'agentStudio', managerOnly: true },
      { path: '/ai/knowledge', labelKey: 'nav.knowledgeBase', label: 'Knowledge', icon: BookOpen, feature: 'askAi', managerOnly: true },
    ],
  },
  {
    id: 'memberships', labelKey: 'nav.group.memberships', label: 'Memberships', icon: GraduationCap,
    children: [
      { path: '/memberships/courses', labelKey: 'nav.courses', label: 'Courses', icon: GraduationCap, managerOnly: true },
      { path: '/memberships/communities', labelKey: 'nav.communities', label: 'Communities', icon: MessagesSquare, managerOnly: true },
      { path: '/memberships/leaderboard', labelKey: 'nav.leaderboard', label: 'Leaderboard', icon: Trophy, managerOnly: true },
    ],
  },
  {
    id: 'voice', labelKey: 'nav.group.voice', label: 'Voice', icon: Mic,
    children: [
      { path: '/voice', labelKey: 'nav.voice', label: 'Voice', icon: Mic, feature: 'voiceAi', managerOnly: true },
      { path: '/voice/ivr', labelKey: 'nav.ivr', label: 'Phone Tree', icon: ListTree, feature: 'voiceAi', managerOnly: true },
    ],
  },
  {
    id: 'reporting', labelKey: 'nav.group.reporting', label: 'Reporting', icon: PieChart,
    children: [
      { path: '/reports', labelKey: 'nav.reports', label: 'Reports', icon: BarChart3 },
      { path: '/ads', labelKey: 'nav.adReporting', label: 'Ads', icon: MousePointerClick },
      { path: '/performance', labelKey: 'nav.performance', label: 'Performance', icon: LineChart },
      { path: '/analytics', labelKey: 'nav.analytics', label: 'Analytics', icon: PieChart, managerOnly: true },
    ],
  },
  {
    id: 'payments', labelKey: 'nav.group.payments', label: 'Payments', icon: Banknote,
    children: [
      { path: '/products', labelKey: 'nav.products', label: 'Products', icon: Package, managerOnly: true },
      { path: '/subscriptions', labelKey: 'nav.subscriptions', label: 'Subscriptions', icon: Repeat, managerOnly: true },
      { path: '/order-forms', labelKey: 'nav.orderForms', label: 'Order forms', icon: ShoppingCart, managerOnly: true },
      { path: '/invoices', labelKey: 'nav.invoices', label: 'Invoices', icon: Banknote, feature: 'invoicing', managerOnly: true },
      { path: '/settings/tax-rates', labelKey: 'nav.taxRates', label: 'Tax Rates', icon: Percent, managerOnly: true },
      { path: '/settings/coupons', labelKey: 'nav.coupons', label: 'Coupons', icon: Ticket, managerOnly: true },
      { path: '/billing', labelKey: 'nav.billing', label: 'Billing', icon: CreditCard, managerOnly: true },
    ],
  },
  {
    id: 'agency', labelKey: 'nav.group.agency', label: 'Agency', icon: Building2, agencyOnly: true,
    children: [
      { path: '/agency/locations', labelKey: 'nav.agencyLocations', label: 'Sub-accounts', icon: Building2, managerOnly: true },
      { path: '/agency/snapshots', labelKey: 'nav.agencySnapshots', label: 'Snapshots', icon: Camera, managerOnly: true },
      { path: '/agency/rebilling', labelKey: 'nav.agencyRebilling', label: 'Rebilling', icon: Receipt, managerOnly: true },
    ],
  },
  {
    id: 'settings', labelKey: 'nav.group.settings', label: 'Settings', icon: Settings, area: 'settings',
    children: [
      { path: '/branding', labelKey: 'nav.branding', label: 'Business & Branding', icon: Palette, managerOnly: true },
      { path: '/users', labelKey: 'nav.users', label: 'Team', icon: Users, managerOnly: true },
      { path: '/settings/roles', labelKey: 'nav.roles', label: 'Roles & permissions', icon: Lock, managerOnly: true },
      { path: '/targets', labelKey: 'nav.targets', label: 'Targets', icon: Flag, managerOnly: true },
      { path: '/settings/custom-fields', labelKey: 'nav.customFields', label: 'Custom Fields', icon: SlidersHorizontal, managerOnly: true },
      { path: '/settings/connections', labelKey: 'nav.connections', label: 'Connections', icon: Plug, managerOnly: true },
      { path: '/settings/api-keys', labelKey: 'nav.apiKeys', label: 'API Keys', icon: KeyRound, managerOnly: true },
      { path: '/settings/webhooks', labelKey: 'nav.webhooks', label: 'Webhooks', icon: Webhook, managerOnly: true },
      { path: '/settings/inbound-webhooks', labelKey: 'nav.inboundWebhooks', label: 'Inbound webhooks', icon: Webhook, managerOnly: true },
      { path: '/settings/compliance', labelKey: 'nav.compliance', label: 'Compliance', icon: Scale, managerOnly: true },
      { path: '/settings/sending-domains', labelKey: 'nav.sendingDomains', label: 'Sending Domains', icon: Mail, managerOnly: true, feature: 'sendingDomains' },
      { path: '/settings/custom-domains', labelKey: 'nav.customDomains', label: 'Custom Domains', icon: Globe, managerOnly: true, feature: 'customDomains' },
      { path: '/settings/telephony', labelKey: 'nav.telephony', label: 'Phone (Netsantral)', icon: PhoneCall, feature: 'telephony', managerOnly: true },
      { path: '/settings/two-factor', labelKey: 'nav.twoFactor', label: 'Two-factor auth', icon: ShieldCheck },
      { path: '/research', labelKey: 'nav.research', label: 'Research', icon: FlaskConical, managerOnly: true },
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
