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
  Flag,
  FlaskConical,
  CreditCard,
  Sparkles,
  BookOpen,
  Inbox,
  MessagesSquare,
  Zap,
  Megaphone,
  Globe,
  CalendarDays,
  Star,
  Mic,
  Banknote,
  Palette,
} from 'lucide-react';

/**
 * Single source of truth for the workspace console's navigation.
 *
 * The whole "everything looks scattered / there's no wayfinding" problem came
 * from a flat list of ~26 links shown purely by role — including advanced
 * modules the workspace's package doesn't even include, which dead-ended on
 * empty pages. Here every item declares:
 *   - the GROUP it belongs to (Pipeline · Sales · Growth · Settings), and
 *   - an optional `feature` entitlement key — items whose feature the workspace
 *     isn't entitled to are simply not rendered (see {@link useEntitlements}).
 *
 * Net effect: a core-only workspace sees a focused ~8–10 item menu; the
 * GoHighLevel-parity "Growth" modules only appear once their package unlocks
 * them. Keeping this declarative (not hand-rolled in the sidebar) is what lets
 * the menu stay coherent as features come and go.
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
  | 'invoicing';

type IconType = LucideIcon;

export interface NavItem {
  path: string;
  /** i18n key; `label` is the inline fallback so a missing translation still reads well. */
  labelKey: string;
  label: string;
  icon: IconType;
  /** When set, the item is hidden unless the workspace is entitled to this feature. */
  feature?: FeatureKey;
  /** When true, only OWNER/MANAGER see it. */
  managerOnly?: boolean;
}

export interface NavGroup {
  id: string;
  labelKey: string;
  label: string;
  items: NavItem[];
  /** Collapsible groups remember their open/closed state (Growth, which can be long). */
  collapsible?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'pipeline',
    labelKey: 'nav.group.pipeline',
    label: 'Pipeline',
    items: [
      { path: '/dashboard', labelKey: 'nav.dashboard', label: 'Dashboard', icon: Home },
      { path: '/leads', labelKey: 'nav.leads', label: 'Leads', icon: Users },
      { path: '/tasks', labelKey: 'nav.tasks', label: 'Tasks', icon: ClipboardList },
      { path: '/calendar', labelKey: 'nav.calendar', label: 'Calendar', icon: Calendar },
      { path: '/offers', labelKey: 'nav.offers', label: 'Offers', icon: FileText },
    ],
  },
  {
    id: 'sales',
    labelKey: 'nav.group.sales',
    label: 'Sales',
    items: [
      { path: '/calls', labelKey: 'nav.calls', label: 'Calls', icon: Phone, feature: 'telephony' },
      { path: '/commissions', labelKey: 'nav.commissions', label: 'Commissions', icon: DollarSign, feature: 'commissions' },
      { path: '/installations', labelKey: 'nav.installations', label: 'Installations', icon: Wrench, feature: 'installations' },
      { path: '/reports', labelKey: 'nav.reports', label: 'Reports', icon: BarChart3 },
      { path: '/performance', labelKey: 'nav.performance', label: 'Performance', icon: LineChart },
    ],
  },
  {
    id: 'growth',
    labelKey: 'nav.group.growth',
    label: 'Growth',
    collapsible: true,
    items: [
      { path: '/inbox', labelKey: 'nav.inbox', label: 'Inbox', icon: Inbox, feature: 'conversationAi' },
      { path: '/channels', labelKey: 'nav.channels', label: 'Channels', icon: MessagesSquare, feature: 'conversationAi', managerOnly: true },
      { path: '/ai/agents', labelKey: 'nav.agentStudio', label: 'Agent Studio', icon: Sparkles, feature: 'agentStudio', managerOnly: true },
      { path: '/ai/knowledge', labelKey: 'nav.knowledgeBase', label: 'Knowledge', icon: BookOpen, feature: 'askAi', managerOnly: true },
      { path: '/automations', labelKey: 'nav.automations', label: 'Automations', icon: Zap, feature: 'workflows', managerOnly: true },
      { path: '/campaigns', labelKey: 'nav.campaigns', label: 'Campaigns', icon: Megaphone, feature: 'campaigns', managerOnly: true },
      { path: '/sites', labelKey: 'nav.sites', label: 'Sites', icon: Globe, feature: 'funnels', managerOnly: true },
      { path: '/booking', labelKey: 'nav.booking', label: 'Booking', icon: CalendarDays, feature: 'funnels', managerOnly: true },
      { path: '/reviews', labelKey: 'nav.reviews', label: 'Reviews', icon: Star, feature: 'reviews', managerOnly: true },
      { path: '/voice', labelKey: 'nav.voice', label: 'Voice', icon: Mic, feature: 'voiceAi', managerOnly: true },
      { path: '/invoices', labelKey: 'nav.invoices', label: 'Invoices', icon: Banknote, feature: 'invoicing', managerOnly: true },
    ],
  },
  {
    id: 'settings',
    labelKey: 'nav.group.settings',
    label: 'Settings',
    items: [
      { path: '/users', labelKey: 'nav.users', label: 'Team', icon: Users, managerOnly: true },
      { path: '/targets', labelKey: 'nav.targets', label: 'Targets', icon: Flag, managerOnly: true },
      { path: '/research', labelKey: 'nav.research', label: 'Research', icon: FlaskConical, managerOnly: true },
      { path: '/branding', labelKey: 'nav.branding', label: 'Branding', icon: Palette, managerOnly: true },
      { path: '/billing', labelKey: 'nav.billing', label: 'Billing', icon: CreditCard, managerOnly: true },
    ],
  },
];

export interface NavVisibilityOpts {
  isManager: boolean;
  /** Entitlement check; `has(undefined)` is true (core item). */
  has: (feature?: FeatureKey) => boolean;
}

/**
 * Pure nav gating used by the sidebar (extracted so it's unit-testable without
 * rendering): drop items the user's role/entitlement can't see, then drop any
 * group left empty. This is the function that turns the flat 26-link menu into
 * a focused, package-appropriate one.
 */
export function visibleNav(groups: NavGroup[], opts: NavVisibilityOpts): NavGroup[] {
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) => (i.managerOnly ? opts.isManager : true) && opts.has(i.feature),
      ),
    }))
    .filter((g) => g.items.length > 0);
}
