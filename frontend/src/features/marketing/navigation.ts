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
  GitBranch,
  Target,
  FlaskConical,
  CreditCard,
  Sparkles,
  Clapperboard,
  BookOpen,
  Inbox,
  Zap,
  Mail,
  Star,
  BadgeDollarSign,
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
  Compass,
  Bot,
} from 'lucide-react';

/**
 * Single source of truth for the workspace console's navigation.
 *
 * 2026-08 SURFACE MERGE: fifteen hubs became THREE surfaces + Settings. The
 * 2026-07 pass below cut the page count; it did not change the premise that you
 * operate this product by picking a hub, and fifteen doors is not navigation,
 * it is an inventory. The home screen is now where work starts (say what you
 * want / approve what is waiting / see what happened), so what is left is a
 * coarse answer to "where would I go to look at that myself":
 *
 *   - home    — /home only.
 *   - inbox   — WORK: anything with a person attached (the old contacts, sales,
 *               calendar, tasks and voice hubs).
 *   - studio  — MAKE & MEASURE (the old reports and growth hubs).
 *   - settings— SET UP: configure once, let it run (the old strategy,
 *               automation, payments, sites, memberships and agency hubs).
 *
 * NOTHING was deleted. Every retired hub's items moved into a surviving
 * surface, gates and all — the path set is frozen in navigation.test.ts and a
 * dropped route fails there. Because a gate that used to hang on a hub now
 * hangs on the item, `NavChild` grew `agencyOnly` and single-page hubs like
 * Sites/Courses/Inbox became gated CHILDREN rather than gated surfaces.
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
 * OWNER/MANAGER; `ownerOnly` only to an OWNER; `feature` items only when the
 * workspace is entitled (see {@link useEntitlements}); `agencyOnly` items only
 * in an AGENCY workspace. Empty hubs (all children gated out) drop from the
 * menu. Packaging changed in 2026-08; gating did not.
 */

/** Entitlement keys the backend's EntitlementsService exposes (subset used in nav). */
export type FeatureKey =
  | 'telephony'
  | 'installations'
  | 'commissions'
  | 'conversationAi'
  // Split off `conversationAi` (NetGSM SMS v2 program): SMS campaigns + SMS
  // channel management. Granted on every plan (no regression); inbox/
  // conversations stay on `conversationAi`.
  | 'sms'
  | 'workflows'
  | 'campaigns'
  | 'funnels'
  | 'reviews'
  | 'askAi'
  | 'agentStudio'
  | 'voiceAi'
  | 'invoicing'
  // AI Social Content Studio — media generation + the Social Campaign engine.
  | 'mediaGen'
  | 'socialCampaigns'
  // Optional modules hidden by default for NEW workspaces (leaner first-run;
  // switch on in Modules). Existing workspaces (activatedModules null) keep them.
  | 'memberships'
  | 'research'
  // NetGSM SMS v2 Task 12 — SMS OTP (2FA-SMS factor + lead phone verification)
  // is a PAID NetGSM add-on, sold standalone: `false` on every plan, only a
  // purchased add-on turns it on. NOT a Settings > Modules toggle (there is no
  // MODULE_META row for it) — see entitlements.service.ts's
  // TOGGLEABLE_MODULE_KEYS comment for why.
  | 'smsOtp'
  // NetGSM Phase 5 — voice campaigns (TTS/audio blasts via `/voicesms/send`,
  // press-1 workflow triggers). Granted on SCALE/OPERATOR plans AND
  // purchasable standalone as a WorkspaceAddOn on lower tiers. UNLIKE
  // smsOtp, this IS a Settings > Modules toggle (see the MODULE_META row).
  | 'voiceCampaigns'
  // NetGSM Phase 6 Task 1 — fax (two-step `/fax/send` multipart + `/fax/receive`
  // poll). Granted on the OPERATOR plan only AND purchasable standalone as a
  // WorkspaceAddOn on every other tier. Same shape as voiceCampaigns: IS a
  // Settings > Modules toggle (see the MODULE_META row) — gates the "Send fax"
  // action on the lead/conversation views.
  | 'fax'
  // Platform-level inert features (env-gated; surfaced via /billing/summary so the
  // nav hides them until ops enables the feature, instead of showing a 503 button).
  | 'prospecting'
  | 'sendingDomains'
  | 'customDomains';

type IconType = LucideIcon;

export interface NavChild {
  path: string;
  /**
   * Other routes that open THIS page and hold no place of their own in the
   * menu. One item, several doors.
   *
   * Added 2026-08-30 for `/inbox`. Since v2.284.0 it and `/leads` render the
   * identical element with no prop between them (App.tsx
   * `MERGED_SURFACE_ROUTES`), so listing both offered a choice nobody can make
   * correctly. The route survives — it is in the frozen path set and in
   * people's bookmarks — and by living here rather than as a second child it
   * keeps being RESOLVED (`findActiveHub`, `findActiveChild`, Breadcrumbs)
   * without being RENDERED. Drop it and someone arriving on their old bookmark
   * loses the chrome that tells them where they are.
   *
   * Not a redirect: both routes must keep working, and a redirect would rewrite
   * a URL people have saved.
   */
  aliases?: string[];
  /** Visible when ANY of these features is on — for a page that merged two
   *  separately-gated ones. Applied on top of `feature`, not instead of it. */
  anyFeature?: readonly FeatureKey[];
  /**
   * The named views INSIDE this page, for surfaces that can offer more than a
   * flat list — the command palette, today.
   *
   * A page that absorbed another keeps the shorter sidebar AND the absorbed
   * page's name. Without this the merge would trade one problem for a worse
   * one: somebody who knows the thing is called "Roles" types it, finds
   * nothing, and concludes it was removed. The sidebar is a list you scan and
   * the palette is a thing you ASK, and only the list was too long.
   *
   * Deliberately not rendered in the sidebar. Every one of these is one click
   * from a page already in it, and putting them back would rebuild the list
   * this exists to shorten.
   */
  tabs?: readonly {
    tab: string;
    labelKey: string;
    label: string;
    /**
     * The entitlement this HALF needs, when it is stricter than the page's.
     *
     * Several pages that became tabs carried their own gate — /calls needed
     * `telephony`, /automations `workflows`, /invoices `invoicing`. Folding them
     * in without carrying the gate would offer a workspace a tab for a feature
     * it has not bought, which is worse than the long list this merge replaced:
     * a list you cannot use is a list that lies.
     */
    feature?: FeatureKey;
  }[];
  /** i18n key; `label` is the inline fallback so a missing translation still reads well. */
  labelKey: string;
  label: string;
  icon?: IconType;
  /** When set, the child is hidden unless the workspace is entitled to this feature. */
  feature?: FeatureKey;
  /** When true, only OWNER/MANAGER see it. */
  managerOnly?: boolean;
  /** When true, ONLY an OWNER sees it (stricter than managerOnly). */
  ownerOnly?: boolean;
  /**
   * (Removed 2026-09-04 — see FULL_BLEED_PREFIXES.)
   *
   * Owning the viewport is a property of the ROUTE, not of a menu entry. This
   * lived here until the workflow list stopped being a menu entry at all, at
   * which point the builder silently started rendering inside the settings
   * chrome: a viewport-height canvas in a letterbox beside a 240px sidebar,
   * with nothing anywhere reporting a fault. Any page that leaves the menu
   * would have lost it the same way.
   */
  /**
   * When true, only an AGENCY workspace sees it. Was a hub-level flag only,
   * until the Agency console's pages moved INTO Settings (2026-08 surface
   * merge) — without it here those three pages would have been shown to every
   * workspace, which is a permission change dressed up as a packaging change.
   */
  agencyOnly?: boolean;
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
  /** When true, ONLY an OWNER sees the hub (stricter than managerOnly). */
  ownerOnly?: boolean;
  /** Whole hub only renders for an AGENCY workspace (Epic D). */
  agencyOnly?: boolean;
  /** 'settings' hubs render in the separate Settings area (gear), not the primary rail. */
  area?: 'main' | 'settings';
  /**
   * Progressive-disclosure tier for main-area hubs. 'core' (default) is always
   * in the rail; 'advanced' is tucked behind a collapsed "More" section so the
   * default view stays focused.
   *
   * Currently inert: since the 2026-08 surface merge every hub is 'core', so
   * `splitByTier` returns an empty advanced list and the sidebar's "More"
   * section never renders. The field and its plumbing stay because they are a
   * property of the hub LIST — marking one hub 'advanced' brings the section
   * back with no component change.
   */
  tier?: 'core' | 'advanced';
}

/**
 * Routable pages that deliberately hold NO place in the sidebar.
 *
 * The rail is three surfaces wide (see the rail test in navigation.test.ts)
 * and, more importantly, every
 * entry on it is a claim that this is a place you are meant to go. Some pages
 * are worth keeping and not worth that claim — the KPI dashboard is the first:
 * it lost its rail slot to the home screen, but a power user hitting the
 * command palette should still land on it instead of discovering it is gone.
 *
 * This is the mechanism for retiring a page from a menu without breaking
 * anyone who relies on it, and stage 4 of the one-screen brief (2026-09-01) is
 * the first time it carries real weight: SIX pages left the Inbox menu that day
 * and every one of them still opens, still appears in the command palette, and
 * still names itself in the breadcrumb.
 *
 * ## The gates
 *
 * Until that day this list was ungated by construction, and its own comment
 * said so ("only add pages every signed-in member may open"). `/appointments`
 * is not one of those - every route on MarketingBookingController is
 * `@MarketingRoles('MANAGER')` + `@RequiresFeature('funnels')` - so the list
 * grew the same two gate fields a `NavChild` carries, and `visibleUnlisted`
 * applies them. Listing a page here is a packaging decision; it must never
 * become a permission one.
 *
 * ## Where the departed six are reached from now
 *
 * The palette is the door this list opens, and it is not the only one:
 *
 * - `/opportunities`, `/calendar`, `/tasks` - the person surface RENDERS these
 *   three, embedded, as the Hat / Takvim / Gorevler arrangements of its left
 *   column (stage 2), so their capabilities are on the daily screen rather than
 *   one door away. What `embedded` drops is chrome plus the month GRID, which
 *   is why the view switcher carries a link to the full page. `/opportunities`
 *   also keeps its two links from the lead detail's Sales tab, and `/tasks`
 *   keeps the dashboard's overdue CTA.
 * - `/documents` - the offers / estimates / e-signature hub. Its per-person
 *   half is the record card's Teklifler and Tahmini fiyat sections; EDITING an
 *   offer, the estimate line-item editor, convert-to-invoice and the whole
 *   signing flow exist only here. NEITHER SECTION LINKS HERE - the record card
 *   carries exactly ONE link, to `/leads/:id`, and LeadContextPane.test.tsx
 *   counts them ("adds no second way off the surface"), because "selecting is
 *   not navigating" stops being true the moment a second door opens on that
 *   card. So from the card the door is the palette, like everything else on
 *   this list. What links in from ELSEWHERE is unchanged: the dashboard hero
 *   and NeedsAttention still deep-link `?tab=offers`.
 * - `/appointments` - booking, rescheduling, approving, cancelling. The record
 *   card's Randevular section is READ-ONLY by design and links NOWHERE, for the
 *   same one-link reason - and for a second one: the section carries this
 *   entry's two gates, so the only readers who could follow such a link are
 *   managers on a `funnels` plan, and naming the page to anyone else would
 *   advertise a surface they can never open. The door is the palette.
 * - `/companies` - creating a company, its rollup dialog, its linked contacts,
 *   deleting. The lead detail's CompanyPanel links to it, and the person list's
 *   `Grupla: Sirkete gore` is where a company is met day to day.
 *
 * Ses and Telefon Agaci are NOT here: they moved to a menu (Settings >
 * Telephony) rather than out of one.
 */
export const UNLISTED_DESTINATIONS: Array<{
  path: string;
  labelKey: string;
  label: string;
  icon: IconType;
  /** Same meaning as on a NavChild - see `visibleUnlisted`. */
  feature?: FeatureKey;
  managerOnly?: boolean;
}> = [
  { path: '/dashboard', labelKey: 'nav.dashboard', label: 'Dashboard', icon: Home },
  { path: '/help', labelKey: 'nav.help', label: 'Help', icon: BookOpen },
  // Left the Inbox menu on 2026-09-01 (stage 4). Gates copied verbatim from the
  // entries they replace: five were ungated there and stay ungated here.
  { path: '/companies', labelKey: 'nav.companies', label: 'Companies', icon: Building2 },
  { path: '/opportunities', labelKey: 'nav.opportunities', label: 'Pipeline', icon: Target },
  { path: '/documents', labelKey: 'nav.documents', label: 'Documents', icon: FileText },
  { path: '/calendar', labelKey: 'nav.calendar', label: 'Calendar', icon: Calendar },
  { path: '/appointments', labelKey: 'nav.appointments', label: 'Appointments', icon: CalendarDays, feature: 'funnels', managerOnly: true },
  { path: '/tasks', labelKey: 'nav.tasks', label: 'Tasks', icon: ClipboardList },
];

export const NAV_HUBS: NavHub[] = [
  // Where everyone lands and where most work should start: say what you want,
  // approve what is waiting, see what was done and what is coming. Everything
  // below this line is the manual fallback for when you need to go and look at
  // something yourself — useful, but not the intended way to operate.
  //
  // This REPLACES the old Dashboard entry rather than sitting beside it. Two
  // rail items both meaning "the start of the app" is the duplication this
  // whole change exists to remove. `/dashboard` is still a route and is linked
  // from the home screen for anyone who wants the KPI board.
  { id: 'home', labelKey: 'nav.home', label: 'Home', icon: Home, path: '/home', tier: 'core' },
  {
    // WORK — everything that arrives with a person attached: the conversation,
    // who it is with, what it is worth, when it happens, what you owe them.
    // Absorbed the old `contacts`, `sales`, `calendar`, `tasks` and `voice`
    // hubs; no `path` of its own, so `hubTarget` in MarketingSidebar aims the
    // rail item at the first child — see the note on that child for why the
    // first child is the ungated one.
    id: 'inbox', labelKey: 'nav.inbox', label: 'Inbox', icon: Inbox, tier: 'core',
    children: [
      /**
       * ONE entry for the person-primary surface, and `/inbox` is its alias.
       *
       * Until 2026-08-30 this line was two: `/inbox` (gated on
       * `conversationAi`) and `/leads` (ungated). Since v2.284.0 both render
       * the SAME element with no prop between them, so the menu was offering
       * one page twice — and the gate on the first was doing nothing, because
       * the identical surface sat unguarded on the line below it.
       *
       * `/leads` is the one that survives, and it stays UNGATED, deliberately:
       * `conversationAi`'s real effect on this surface is inside the page (the
       * stream's `gated` signal says "your plan does not include messages"),
       * and a workspace without it still gets people, activities and the record
       * card. Putting the gate on the survivor would take all of that off the
       * menu — the exact regression v2.284.0 was careful to avoid.
       *
       * It is also first in the list, which is what `hubTarget` reads: the rail
       * item for this surface can now never aim at a page you cannot open.
       */
      {
        path: '/leads',
        // Importing people, grouping them and defining what a record can hold
        // are all about the people on THIS surface. They were Settings pages,
        // a whole surface away from the only place their effect is visible.
        aliases: ['/inbox', '/import', '/segments', '/tags', '/settings/custom-fields'],
        labelKey: 'nav.people',
        label: 'People',
        icon: Users,
        tabs: [
          { tab: 'people', labelKey: 'nav.people', label: 'People' },
          { tab: 'import', labelKey: 'nav.import', label: 'Import' },
          { tab: 'audience', labelKey: 'nav.audience', label: 'Segments & tags' },
          { tab: 'fields', labelKey: 'nav.customFields', label: 'Custom Fields' },
        ],
      },
      /**
       * ...and since stage 4 of the one-screen brief (2026-09-01) it is the
       * ONLY one. Six items left this list that day - Sirketler, Satis Hatti,
       * Belgeler, Takvim, Randevular, Gorevler - and two more (Ses, Telefon
       * Agaci) went to Settings.
       *
       * NOTHING WAS DELETED. All eight are still routes; the six are in
       * `UNLISTED_DESTINATIONS` with their gates, which is the palette and the
       * breadcrumb; and three of them are RENDERED on this very surface as the
       * left column's Hat / Takvim / Gorevler arrangements. The audit of which
       * capability is reached from where is written on that list.
       *
       * The reason is the owner's own sentence: fit the inbox on one screen
       * without losing a feature. Nine doors into one person's work is the
       * inventory this line of work exists to stop being - you picked a page
       * and then went looking for the person, when the person is the object and
       * every one of those pages is a view of them.
       */
    ],
  },
  {
    // MAKE & MEASURE — the outbound half of the product. Growth Studio itself
    // (content calendar, Create, campaigns, trends, Autopilot as tabs), what it
    // produced (Reports), and the vertical add-ons that feed it. Absorbed the
    // old `reports` and `growth` hubs.
    id: 'studio', labelKey: 'nav.studio', label: 'Growth Studio', icon: Sparkles, tier: 'core',
    children: [
      /**
       * UNGATED, and it has to be.
       *
       * It carried `managerOnly` until 2026-09-01, which bought nothing and
       * cost the rail its honesty. `/studio` is in App.tsx's plain auth-only
       * group, and three redirects SEND reps here: `/budget`, `/trends` and
       * `/content-calendar` all land on `/studio`, so a rep with any of those
       * bookmarks arrived on a page the menu said was not theirs — with no
       * rail highlight and no sub-nav, because both are built from the
       * FILTERED hub.
       *
       * Nothing on the surface was relying on the gate. Every panel already
       * has an explicit REP branch, each of them tested: AccountStatsPanel's
       * `isManager`, TodayQueuePanel's `canAct`, IdeasPanel's `canDecide`,
       * AutopilotStatusBar's `canManage`, GrowthStudioPage's `ManagerTab` and
       * StudioToolsDrawer's `TOOL_MIN_ROLE` — which refuses `?tool=` at the
       * MOUNT, so the URL is closed too, not just the menu row. And every
       * write behind them is `@MarketingRoles('MANAGER')` server-side. What
       * the gate actually did was leave the rail item labelled "Growth Studio"
       * pointing at Reports.
       *
       * It is also FIRST in this list, which is what `hubTarget` reads (the
       * hub has no `path` of its own), so it must stay ungated for the same
       * reason `/leads` does above. `navigation.test.ts` pins that invariant
       * for every pathless hub now, rather than leaving it to these comments.
       */
      { path: '/studio', labelKey: 'nav.studio', label: 'Growth Studio', icon: Sparkles },
      // Single page: Ads / Performance / Analytics are tabs inside /reports.
      { path: '/reports', labelKey: 'nav.reports', label: 'Reports', icon: BarChart3 },
      { path: '/prospecting', labelKey: 'nav.prospecting', label: 'Prospecting', icon: Globe, feature: 'prospecting' },
      { path: '/commissions', labelKey: 'nav.commissions', label: 'Commissions', icon: DollarSign, feature: 'commissions' },
      { path: '/installations', labelKey: 'nav.installations', label: 'Installations', icon: Wrench, feature: 'installations' },
    ],
  },
  {
    // SET UP — anything you configure once and then let run: the workspace
    // itself, the automations, what you sell and bill, the public surfaces, the
    // developer tooling. Absorbed the old `strategy`, `automation`, `payments`,
    // `sites`, `memberships` and `agency` hubs. Renders in the gear area, so
    // its size costs the rail nothing.
    id: 'settings', labelKey: 'nav.group.settings', label: 'Settings', icon: Settings,
    area: 'settings', tier: 'core',
    children: [
      // Workspace
      // Identity, visual kit, AI brand voice AND the stages a deal moves through:
      // all four are the SHAPE of the business, filled in once by whoever opens
      // the workspace and rarely touched again.
      { path: '/branding', labelKey: 'nav.business', label: 'Business', icon: Palette,
        managerOnly: true, aliases: ['/settings/pipelines'],
        tabs: [
          { tab: 'business', labelKey: 'nav.brand', label: 'Brand' },
          { tab: 'pipelines', labelKey: 'nav.pipelines', label: 'Pipelines' },
        ] },
      // Members and the permissions each role carries — one page, two tabs.
      // Nobody thinks about a role without thinking about the person who has it.
      { path: '/users', labelKey: 'nav.users', label: 'Team', icon: Users, managerOnly: true,
        aliases: ['/settings/roles', '/targets', '/booking'],
        tabs: [
          { tab: 'members', labelKey: 'nav.users', label: 'Team' },
          { tab: 'roles', labelKey: 'nav.roles', label: 'Roles & permissions' },
          { tab: 'targets', labelKey: 'nav.targets', label: 'Targets' },
          { tab: 'booking', labelKey: 'nav.booking', label: 'Booking', feature: 'funnels' },
        ] },
      /**
       * Pipeline + stage configuration — a route since long before this menu,
       * and until 2026-09-01 it was in NO menu at all.
       *
       * It got away with that because `/opportunities` carried a "Pipelines"
       * button in its own PageHeader, so the page had one door even if the
       * navigation had none. Stage 2 renders that board EMBEDDED in the person
       * surface without its header, and stage 4 takes `/opportunities` out of
       * the menu entirely — at which point the only way to reach the one page
       * that defines the stages every deal moves through would have been to
       * type the URL. The button is still there on `/opportunities`; this is
       * the door that does not depend on it.
       *
       * `managerOnly` mirrors the route (`requiredRole={MANAGER}` in App.tsx)
       * and the API (every pipelines write on
       * MarketingOpportunitiesController is manager-gated). Filed under
       * Workspace beside Targets: both are the sales SHAPE a manager sets up
       * once and everyone then works inside.
       */
      /**
       * The call LOG, moved out of the Inbox surface on 2026-08-31.
       *
       * It sat there because calls are a thing you do to a person. But the
       * page itself is not a person: it is the log of every call the workspace
       * made, plus the Power Dialer, which is a bulk outbound tool you point
       * at a list. Neither arrives with a person attached, and that is the one
       * thing the Inbox surface is for.
       *
       * What made the move safe rather than merely tidy is the other half of
       * this change: a call in a person's stream now opens its own recording
       * and its own AI analysis (LeadStream -> StreamCallDetail). Before that,
       * /calls was the ONLY place a rep could hear a call, so taking it off
       * the surface would have removed the capability rather than relocated
       * the page.
       *
       * `/calls` is still a route, still bookmarked, still in the frozen path
       * set navigation.test.ts pins — nothing about the page changed except
       * which menu names it. The Power Dialer stays a TAB of that page: it
       * belongs to the operations surface, not to a person.
       */
      /**
       * Ses and Telefon Agaci, moved off the Inbox surface on 2026-09-01 for
       * the reason the call log moved a day earlier: they are channel
       * CONFIGURATION, not daily work. You record a greeting, wire a menu of
       * options and leave it running for months; nothing here arrives with a
       * person attached, which is the one thing the Inbox surface is for. The
       * calls those trees produce still land in a person's stream, and the log
       * of them is now the item directly above.
       *
       * Both gates travel unchanged (`voiceAi` + managerOnly), mirroring
       * VoiceAiController. This is a menu move, not a route deletion or a
       * permission change: `/voice` and `/voice/ivr` are in the frozen path
       * set and both still resolve.
       */
      // The greeting and the menu the caller hears after it: one sitting of
      // work, and neither half is finished without the other.
      { path: '/voice', labelKey: 'nav.voice', label: 'Voice', icon: Mic, feature: 'voiceAi',
        managerOnly: true, aliases: ['/voice/ivr', '/calls'],
        tabs: [
          { tab: 'assistant', labelKey: 'nav.voice', label: 'Voice' },
          { tab: 'ivr', labelKey: 'nav.ivr', label: 'Phone Tree' },
          { tab: 'calls', labelKey: 'nav.calls', label: 'Calls', feature: 'telephony' },
        ] },
      // Public surfaces you configure once (were their own single-page hubs).
      { path: '/sites', labelKey: 'nav.sites', label: 'Sites & Funnels', icon: Globe, feature: 'funnels', managerOnly: true },
      { path: '/memberships/courses', labelKey: 'nav.courses', label: 'Courses', icon: GraduationCap, feature: 'memberships', managerOnly: true },
      // Set-and-forget automation. The AI Strategy Engine console is the same
      // kind of thing: you tell it the plan and it runs; first-run onboarding
      // still lives at /onboarding/strategy behind the console's CTA.
      // FIRST, and it will stay first: a workspace without a strategy is not one
      // with a blank page, it is one whose automations have nothing to be FOR.
      // The workflows that serve it, and the research that feeds them, are its
      // tabs rather than its siblings — 'AI research' was a third entry whose
      // difference from an automation nobody could state.
      { path: '/studio/strategy', labelKey: 'nav.strategy', label: 'Strategy', icon: Compass,
        managerOnly: true, aliases: ['/automations', '/research'],
        tabs: [
          { tab: 'strategy', labelKey: 'nav.strategy', label: 'Strategy' },
          { tab: 'automations', labelKey: 'nav.automations', label: 'Workflows', feature: 'workflows' },
          { tab: 'research', labelKey: 'nav.research', label: 'Research', feature: 'research' },
        ] },
      // Which fal.ai model — and therefore what per-clip price — this workspace
      // generates on. `managerOnly` mirrors the route's MANAGER gate in App.tsx
      // and the PATCH's own MANAGER + settings.manage floor.
      { path: '/settings/ai-models', labelKey: 'nav.aiModels', label: 'AI models', icon: Clapperboard, managerOnly: true },
      { path: '/trigger-links', labelKey: 'nav.triggerLinks', label: 'Trigger Links', icon: Link2, managerOnly: true },
      /**
       * Three pages that had no menu entry anywhere.
       *
       * They were reachable only as sub-tabs of Growth Studio's "More" tab — a
       * tab inside a tab inside a mode you had to know to open. When the Studio
       * collapsed into one working screen (2026-08) that hiding place went away,
       * and the choice was to give them a permanent home or to lose them.
       *
       * Settings is the right home, and not merely the available one: all three
       * are things a workspace SETS UP and then leaves running — a template
       * library, a partner programme, the review-request configuration — rather
       * than work anybody does daily. They are still reachable from the Studio's
       * tools drawer, so nobody who knew the old route has to learn a new one.
       *
       * Adding them moves the frozen path set in navigation.test.ts by exactly
       * three lines, which that file asks to be done deliberately. This is that.
       */
      { path: '/email-templates', labelKey: 'nav.emailTemplates', label: 'Email Templates', icon: Mail, feature: 'campaigns', managerOnly: true },
      { path: '/reviews', labelKey: 'nav.reviews', label: 'Reviews', icon: Star, feature: 'reviews', managerOnly: true },
      { path: '/affiliates', labelKey: 'nav.affiliates', label: 'Affiliates', icon: BadgeDollarSign, managerOnly: true },
      // Products & billing
      // Tax Rates + Coupons are tabs inside Products now.
      // The whole sale, in the order it happens: what you sell, how somebody
      // buys it, what recurs, what gets paid.
      { path: '/products', labelKey: 'nav.selling', label: 'Selling', icon: Package,
        managerOnly: true, aliases: ['/order-forms', '/subscriptions', '/invoices'],
        tabs: [
          { tab: 'products', labelKey: 'nav.products', label: 'Products' },
          { tab: 'order-forms', labelKey: 'nav.orderForms', label: 'Order forms' },
          { tab: 'subscriptions', labelKey: 'nav.subscriptions', label: 'Subscriptions' },
          { tab: 'invoices', labelKey: 'nav.invoices', label: 'Invoices', feature: 'invoicing' },
        ] },
      // The plan, and the switch that turns features off. Last in the list.
      { path: '/billing', labelKey: 'nav.planAccess', label: 'Plan & access', icon: CreditCard,
        managerOnly: true, aliases: ['/settings/modules'],
        tabs: [
          { tab: 'plan', labelKey: 'nav.billing', label: 'Billing' },
          { tab: 'modules', labelKey: 'nav.modules', label: 'Modules' },
        ] },
      // Data (Custom Objects deleted — 2026-07 trim: an island with no consumer
      // anywhere and no record-to-contact linking UI at all)
      // Moved out of the Contacts hub (2026-08): these SHAPE contacts, they are
      // not contacts you work.
      // A segment is a rule the system keeps applying; a tag is a label somebody
      // Connections & domains (Account Center absorbed Settings→Connections)
      { path: '/accounts', labelKey: 'nav.accounts', label: 'Connections', icon: Plug, managerOnly: true },
      // One job under two names: you own a domain, you paste DNS records, you
      // wait for it to verify. `anyFeature` because each half had its own gate
      // and a workspace with only one of them must still get here.
      { path: '/settings/domains', labelKey: 'nav.domains', label: 'Domains', icon: Globe,
        managerOnly: true, anyFeature: ['sendingDomains', 'customDomains'],
        aliases: ['/settings/sending-domains', '/settings/custom-domains'],
        tabs: [
          { tab: 'sending', labelKey: 'nav.sendingDomains', label: 'Sending Domains' },
          { tab: 'custom', labelKey: 'nav.customDomains', label: 'Custom Domains' },
        ] },
      // Developer & security
      // Keys for your own code and the Claude connector are the same decision:
      // granting something outside this app the right to act inside it.
      { path: '/settings/api-keys', labelKey: 'nav.apiAccess', label: 'API & connector',
        icon: KeyRound, managerOnly: true, aliases: ['/settings/mcp-console'],
        tabs: [
          { tab: 'keys', labelKey: 'nav.apiKeys', label: 'API Keys' },
          { tab: 'connector', labelKey: 'nav.mcpConsole', label: 'Claude connector' },
        ] },
      // Outgoing and inbound are one concept — a URL and a payload — pointing
      // opposite ways. Two names for it taught two names for one idea.
      { path: '/settings/webhooks', labelKey: 'nav.webhooks', label: 'Webhooks', icon: Webhook,
        managerOnly: true, aliases: ['/settings/inbound-webhooks'],
        tabs: [
          { tab: 'outgoing', labelKey: 'nav.webhooks', label: 'Webhooks' },
          { tab: 'inbound', labelKey: 'nav.inboundWebhooks', label: 'Inbound webhooks' },
        ] },
      { path: '/settings/compliance', labelKey: 'nav.compliance', label: 'Compliance', icon: Scale, managerOnly: true },
      { path: '/settings/two-factor', labelKey: 'nav.twoFactor', label: 'Two-factor auth', icon: ShieldCheck },
      // Agency console — every /agency/* backend route is @MarketingRoles('OWNER'),
      // and the pages only mean anything for an AGENCY workspace. Both gates ride
      // on the items now that the hub they used to hang on is gone.
      { path: '/agency/locations', labelKey: 'nav.agencyLocations', label: 'Sub-accounts', icon: Building2, managerOnly: true, ownerOnly: true, agencyOnly: true },
      { path: '/agency/snapshots', labelKey: 'nav.agencySnapshots', label: 'Snapshots', icon: Camera, managerOnly: true, ownerOnly: true, agencyOnly: true },
      { path: '/agency/rebilling', labelKey: 'nav.agencyRebilling', label: 'Rebilling', icon: Receipt, managerOnly: true, ownerOnly: true, agencyOnly: true },
    ],
  },
];

export interface NavVisibilityOpts {
  isManager: boolean;
  /** Entitlement check; `has(undefined)` is true (core item). */
  has: (feature?: FeatureKey) => boolean;
  /** True only for an AGENCY workspace — gates the `agencyOnly` hub (Epic D). */
  isAgency?: boolean;
  /** True only for an OWNER — gates `ownerOnly` items (the whole Agency console,
   *  whose every backend route is @MarketingRoles('OWNER')). */
  isOwner?: boolean;
}

/** The four gates, read off anything that carries them. */
function gatesPass(
  g: {
    feature?: FeatureKey;
    anyFeature?: readonly FeatureKey[];
    managerOnly?: boolean;
    ownerOnly?: boolean;
    agencyOnly?: boolean;
  },
  opts: NavVisibilityOpts,
): boolean {
  return (
    (g.managerOnly ? opts.isManager : true) &&
    (g.ownerOnly ? !!opts.isOwner : true) &&
    (g.agencyOnly ? !!opts.isAgency : true) &&
    opts.has(g.feature) &&
    // A page that MERGED two separately-gated ones is reachable when EITHER of
    // them is on. Squeezing it back into the single `feature` gate would take
    // the page away from a workspace that has only the other half — which is a
    // regression the merge itself created, not a rule anybody chose.
    (g.anyFeature ? g.anyFeature.some((f) => opts.has(f)) : true)
  );
}

function childVisible(c: NavChild, opts: NavVisibilityOpts): boolean {
  return gatesPass(c, opts);
}

/**
 * The UNLISTED destinations this user may actually open.
 *
 * Shares `gatesPass` with the sidebar rather than re-implementing it, which is
 * the whole point: the command palette must never jump anyone to a page their
 * role or plan hides, and a second copy of that rule is a second place for it
 * to rot. It matters as of 2026-09-01, when six pages moved into that list and
 * one of them (`/appointments`) is manager-only and plan-gated.
 */
export function visibleUnlisted(
  opts: NavVisibilityOpts,
): typeof UNLISTED_DESTINATIONS {
  return UNLISTED_DESTINATIONS.filter((d) => gatesPass(d, opts));
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
      (h.managerOnly ? opts.isManager : true) &&
      (h.ownerOnly ? !!opts.isOwner : true) && opts.has(h.feature));
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

/**
 * All routable paths a hub owns: its own `path`, every child path, and every
 * child ALIAS. Aliases belong here or arriving on `/inbox` would resolve to no
 * hub at all — no active rail item, no sub-nav, no breadcrumb — which is what
 * "the route survives" has to mean beyond the router not 404ing.
 */
function hubPaths(h: NavHub): string[] {
  const paths = h.children ? h.children.flatMap((c) => [c.path, ...(c.aliases ?? [])]) : [];
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

/**
 * The CHILD that owns `pathname`, by the same longest-prefix rule as
 * {@link findActiveHub} — so `/automations/42/edit` resolves to the
 * `/automations` item, not merely to the hub containing it. Undefined when the
 * match is a single-page hub (which has no child) or nothing matches.
 */
/**
 * Routes that own the whole viewport, whatever area they belong to.
 *
 * The workflow builder is a `h-[calc(100vh-7rem)]` canvas and the settings pane
 * is a heightless scroll column beside a 240px sidebar, so inside it the canvas
 * renders letterboxed. Giving the pane `h-full` would fix the height and leave
 * the canvas jammed against the sidebar, so the page leaves the area instead.
 *
 * A PREFIX list keyed on the path, deliberately: the flag used to ride on the
 * nav item, and disappeared the day that item was absorbed into another page.
 * These routes are full-bleed whether or not anything lists them.
 */
export const FULL_BLEED_PREFIXES = ['/automations'] as const;

export function isFullBleedPath(pathname: string): boolean {
  return FULL_BLEED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function findActiveChild(hubs: NavHub[], pathname: string): NavChild | undefined {
  let best: { child: NavChild; len: number } | undefined;
  for (const h of hubs) {
    for (const c of h.children ?? []) {
      // An alias is the same item under another URL, so it resolves to the same
      // child — `/inbox` must answer with the `/leads` item, not with nothing.
      for (const p of [c.path, ...(c.aliases ?? [])]) {
        if (pathname === p || pathname.startsWith(p + '/')) {
          if (!best || p.length > best.len) best = { child: c, len: p.length };
        }
      }
    }
  }
  return best?.child;
}

/**
 * Whether moving from `prevHubId` to `nextHubId` should auto-open the sidebar's
 * "More" (advanced) section. TRUE only for a genuine in-session navigation INTO
 * an advanced hub — never for the initial resolution (`prevHubId === undefined`,
 * i.e. a cold mount / reload where the active hub id resolves from undefined
 * once entitlements load). Without the undefined guard, sitting on an advanced
 * page and pressing F5 would snap a manually-collapsed "More" back open,
 * defeating the persisted collapse preference (sidebarPrefsStore).
 */
export function shouldAutoOpenAdvanced(
  prevHubId: string | undefined,
  nextHubId: string | undefined,
  nextIsAdvanced: boolean,
): boolean {
  return prevHubId !== undefined && nextHubId !== prevHubId && nextIsAdvanced;
}
