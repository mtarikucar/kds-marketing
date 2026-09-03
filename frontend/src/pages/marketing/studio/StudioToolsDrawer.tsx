import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, Lock, Sparkles } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/Sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { FeatureGate } from '@/components/ui/access-gates';
import { useEntitlements } from '@/features/marketing/hooks/useEntitlements';
import { useWorkspaceProfile } from '@/features/marketing/hooks/useWorkspaceProfile';
import { hasMarketingRole, MarketingRole } from '@/features/marketing/types';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import type { FeatureKey } from '@/features/marketing/navigation';
import { RouteFallback } from '../../../components/RouteFallback';
import {
  listGrowthBudgets,
  listPendingApprovals,
} from '../../../features/marketing/api/growthBudget.service';
import { BudgetDialog } from '../budget/BudgetDialog';
import { EnableAutopilotWizard } from '../budget/EnableAutopilotWizard';
import { UpgradeCallout } from './UpgradeCallout';

// Lazy, so none of these surfaces costs anything until the drawer opens on one.
// The Autopilot console alone drags in the wizard, the activity feed and the
// allocator tables; the Studio's three working panels must not pay for that.
const BudgetAutopilotPage = lazy(() => import('../budget/BudgetAutopilotPage'));
const StudioCalendarTab = lazy(() => import('./StudioCalendarTab'));
const ContentLinePanel = lazy(() =>
  import('./ContentLinePanel').then((m) => ({ default: m.ContentLinePanel })),
);
const BatchDetail = lazy(() =>
  import('./BatchDetail').then((m) => ({ default: m.BatchDetail })),
);
const AiStudioPage = lazy(() => import('../social/AiStudioPage'));
/**
 * The ACCOUNT CENTER, not `settings/connections/ConnectionsPage`.
 *
 * The two are easy to confuse and this drawer had the wrong one. The page under
 * `settings/connections` is the CALENDAR sync surface — Google Calendar and
 * Outlook — while the tool this drawer offers is "your connected accounts": the
 * social profiles it publishes to and the ad accounts it reports on. The header
 * promised the latter and mounted the former, so the one thing a reader came for
 * was the one thing not on screen.
 *
 * `AccountCenterPage` is also the superset: it renders the calendar section
 * itself, so nothing is lost by pointing at it instead.
 */
const AccountCenterPage = lazy(() => import('../accounts/AccountCenterPage'));

/*
 * The recurring operations, each one an existing page mounted here rather than
 * linked to. A link would be the detour: every one of these routes is a child
 * of the single `area: 'settings'` hub, so `MarketingLayout` swaps the whole app
 * chrome for `SettingsLayout` the moment you land on one. Navigating to
 * /invoices from the Studio IS the gear trip, even from a button on the Studio.
 *
 * Each is named for the route it is the page of, because that route still
 * exists and still works — this drawer is an ADDITIONAL door, not a move.
 */
const InvoicesPage = lazy(() => import('../invoices')); // /invoices
const SubscriptionsPage = lazy(() => import('../subscriptions/SubscriptionsPage')); // /subscriptions
const BillingPage = lazy(() => import('../billing')); // /billing
const CouponsPage = lazy(() => import('../settings/coupons')); // /settings/coupons
const RebillingPage = lazy(() => import('../agency/RebillingPage')); // /agency/rebilling
const AutomationsListPage = lazy(() => import('../automations/AutomationsListPage')); // /automations
const TriggerLinksPage = lazy(() => import('../triggerLinks')); // /trigger-links
const WebhooksPage = lazy(() => import('../settings/webhooks/WebhooksPage')); // /settings/webhooks
/** Section 4 of the MCP console only — the audit list. Sections 1-3 (endpoint,
 *  keys, write-mode switch) are one-time setup and stay page-only. */
const McpSessionsSection = lazy(() =>
  import('../settings/mcpConsole/McpConsolePage').then((m) => ({ default: m.SessionsSection })),
);
/** The request HISTORY half of /settings/compliance. The per-person half moved
 *  to the Inbox record card, where the person is already selected. */
const ComplianceRequestsSection = lazy(() =>
  import('../settings/compliance/CompliancePage').then((m) => ({
    default: m.ComplianceRequestsSection,
  })),
);
const ResearchSuggestionsPage = lazy(() => import('../research/ResearchSuggestionsPage')); // /research/suggestions
const ResearchSettingsPage = lazy(() => import('../research/ResearchSettingsPage')); // /research
const ImportWizardPage = lazy(() => import('../imports')); // /import
const SegmentsPage = lazy(() => import('../crm/segments')); // /segments

/**
 * The tools that used to be tabs on `/studio`, plus the recurring operations
 * Settings was holding. Deliberately a tiny closed union: `StudioOneScreen`
 * decides which one is open — it is the thing that reads `?tool=` — and this
 * component only renders what it is told. Keeping `useSearchParams` out of here
 * is what lets the same drawer be driven by a URL, by a button, or by a test.
 *
 * The last three are not new PAGES. Each is a STACK of existing pages, mounted
 * `embedded` inside a `Disclosure` apiece: `money` is Faturalar · Abonelikler ·
 * Kredi ve paket · Kuponlar · Yeniden faturalama, `ops` is Workflow'lar ·
 * Tetikleyici linkler · Webhook teslimatları · Claude oturumları · Veri
 * talepleri, `audience` is AI aday önerileri · Araştırma profilleri · İçe
 * aktarım · Segmentler. A closed disclosure never runs its child's function, so
 * a five-page tool costs exactly one query — the one section that opens itself.
 *
 * Nothing maps the older `?view=tools&tab=…` links onto this drawer, and no
 * code here should be written as though something did. Those URLs are read by
 * `GrowthStudioPage`, which renders the separate full-page `ToolsSurface` for
 * them; the drawer's menu below merely LINKS to that surface. Deleting
 * `ToolsSurface` on the belief that this drawer had absorbed it would take
 * seven live destinations with it.
 */
export type StudioTool =
  | 'autopilot'
  | 'calendar'
  | 'create'
  | 'connections'
  | 'money'
  | 'ops'
  | 'audience'
  | 'line';

/**
 * What each tool's UNDERLYING page actually requires — the audit, written down,
 * because getting it wrong is how this drawer shipped a role bypass.
 *
 * The trap is structural, not a slip: `/studio` sits in App.tsx's plain
 * auth-only group, and every one of these tools is a page that lives (or would
 * live) somewhere else with its own gate. Mounting one here silently re-hosts it
 * under `/studio`'s weaker guard. `?tool=connections` did exactly that — it
 * rendered `AccountCenterPage`, the page App.tsx puts behind
 * `requiredRole={MarketingRole.MANAGER}` at `/accounts`, to anybody who could
 * reach the Studio at all. Hiding the menu row is not the fix, because the row
 * is not the door: the URL is. So the refusal lives HERE, at the mount, and
 * StudioToolsMenu's filter is only there to stop offering a door that will not
 * open.
 *
 *   autopilot   — no role. `GET marketing/budget`, `/budget/:id`, `/wallet`,
 *                 `/runs` and `/activity` are all `reports.read` with no
 *                 `@MarketingRoles`, so a REP may genuinely READ the console.
 *                 Every write (`POST /budget`, `/quick-start`, the kill switch,
 *                 the autonomy and status patches) is MANAGER + `settings.manage`,
 *                 and the two triggers this header owns are `canManage`-gated
 *                 below. Honoured.
 *   calendar    — no role. `GET marketing/content-calendar` is `reports.read`
 *                 with no role, so the month is readable by everyone. Its one
 *                 manager-shaped affordance is the "generate weekly plan" CTA
 *                 (it POSTs a SocialCampaign, MANAGER + `campaigns.send`, and
 *                 reads `GET /social-planner/accounts`, MANAGER) — gated inside
 *                 StudioCalendarTab, not here, because the calendar underneath
 *                 it is not manager-only and wrapping the whole tab would hide a
 *                 page a REP is entitled to. Honoured.
 *   create      — MANAGER, plus the `mediaGen` entitlement. `MarketingMediaController`
 *                 carries BOTH `@MarketingRoles('MANAGER')` and
 *                 `@RequiresFeature('mediaGen')` at class level, so for a REP
 *                 the library query 403s on mount (and AiStudioPage does not set
 *                 `meta.silent`, so it toasts) and every generate 403s on click.
 *                 The drawer used to check only the entitlement — half the gate.
 *   connections — MANAGER. `/accounts` is `requiredRole={MarketingRole.MANAGER}`
 *                 in App.tsx and `AccountCenterController` is
 *                 `@MarketingRoles('MANAGER')` on every route it has.
 *   money       — MANAGER, and this row is the GATE rather than a second layer.
 *                 Every page in the stack is `managerOnly` in navigation.ts and
 *                 MANAGER server-side: /invoices, /subscriptions, /billing,
 *                 /settings/coupons, and /agency/rebilling (which is
 *                 AGENCY-OWNER on top). Without this row a rep who typed
 *                 `/studio?tool=money` would reach the AR ledger, because
 *                 `/studio` is in App.tsx's plain auth-only group and the menu
 *                 filter below hides the ROW, never the URL.
 *   ops         — MANAGER. /automations, /trigger-links, /settings/webhooks and
 *                 /settings/mcp-console are all `managerOnly`; the compliance
 *                 controller is class-level `@MarketingRoles('MANAGER')`.
 *   audience    — MANAGER. /research, /research/suggestions, /import and
 *                 /segments are all `managerOnly`.
 *
 * A tool absent from this map requires no role. Keep it in step with App.tsx: a
 * tool that becomes manager-only there and not here is the same bug again.
 */
const TOOL_MIN_ROLE: Partial<Record<StudioTool, MarketingRole>> = {
  create: MarketingRole.MANAGER,
  connections: MarketingRole.MANAGER,
  money: MarketingRole.MANAGER,
  ops: MarketingRole.MANAGER,
  audience: MarketingRole.MANAGER,
  line: MarketingRole.MANAGER,
};

export interface StudioToolsDrawerProps {
  open: boolean;
  /** Which tool to mount. `null` while the drawer is closed. */
  tool: StudioTool | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Everything the Studio's three panels do NOT do, one click to the right.
 *
 * Two things forced a drawer rather than more routes. First, `/studio` used to
 * BE the Autopilot console, and a screen that quietly drops a money-spending
 * engine is worse than a busy screen — so the console has to stay reachable
 * from here, in context, without a navigation that loses the panels behind it.
 * Second, the old tools hub owned a pile of deep links that nothing else in the
 * product points at; if they are not offered here they are unreachable, which
 * is a worse regression than any amount of layout debt. Hence the dropdown at
 * the bottom of the header: it is a reachability guarantee, and its contents
 * are pinned by a test for exactly that reason.
 */
export function StudioToolsDrawer({ open, tool, onOpenChange }: StudioToolsDrawerProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const user = useMarketingAuthStore((s) => s.user);
  const canManage = hasMarketingRole(user?.role, MarketingRole.MANAGER);
  // Only the Para stack's last section reads this, and it fails CLOSED while
  // the profile is in flight — the hook is shared with the sidebar nav, so it
  // is a cache hit rather than a request of this drawer's own.
  const { isAgency } = useWorkspaceProfile();

  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  /**
   * Which batch the content line is showing, if any. LOCAL state, not a search
   * param: the drawer itself is already URL-addressed by `?tool=line`, and a
   * second param for a view that only exists inside it would outlive the
   * drawer it belongs to.
   */
  const [openedBatch, setOpenedBatch] = useState<string | null>(null);

  /**
   * A drawer opened with no tool named still has to render something — Radix
   * keeps the panel mounted through its close animation, and the page may hand
   * us `null` for a `?tab=` value that is not one of ours. The Autopilot is the
   * right default: it is what `/studio` showed before this screen existed.
   */
  const active: StudioTool = tool ?? 'autopilot';

  /**
   * The gate, applied at the MOUNT rather than at the menu — see TOOL_MIN_ROLE.
   * `?tool=` is a URL anyone can type, so filtering the dropdown hides the
   * entry, not the page; this is what actually refuses it.
   */
  const required = TOOL_MIN_ROLE[active];
  const allowed = !required || hasMarketingRole(user?.role, required);

  // Same key the console and the status bar use, so this is a cache hit in
  // practice; `enabled` keeps a closed drawer from ever issuing it. It exists
  // only to label the budget trigger create-vs-edit and to decide whether the
  // "Enable Autopilot" trigger belongs here at all.
  const budgetsQ = useQuery({
    queryKey: ['growth-budgets'],
    queryFn: listGrowthBudgets,
    enabled: open && active === 'autopilot',
    meta: { silent: true },
  });
  const currentBudget = budgetsQ.data?.[0];

  /**
   * The count only — see `PendingApprovalsLink` below for why a count and not
   * the queue. Same key and same fetcher as `ApprovalQueue`, deliberately with
   * NO `meta`, so that mounting this never changes whether the rail's own copy
   * of the query toasts on failure; the rail renders a QueryStateBoundary and
   * owns that decision. This badge simply does not appear if the read fails,
   * which is the honest thing for a number whose only job is to say "there is
   * something behind this overlay".
   */
  const approvalsQ = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: listPendingApprovals,
    enabled: open && active === 'autopilot',
  });
  const pendingApprovals = approvalsQ.data?.length ?? 0;

  /** Exactly the console's own post-save refresh: list, wallet, and the
   *  per-budget detail (`['growth-budget', id]`) that the detail view and the
   *  status bar's Growth Multiple both read. Miss the third and a saved cap
   *  shows up in the strip but not in the table underneath it. */
  const refreshBudget = () => {
    qc.invalidateQueries({ queryKey: ['growth-budgets'] });
    qc.invalidateQueries({ queryKey: ['growth-wallet'] });
    qc.invalidateQueries({ queryKey: ['growth-budget'] });
  };

  const meta: Record<StudioTool, { title: string; description: string }> = {
    autopilot: {
      title: t('studio.tools.autopilot.title', 'Otomatik pilot konsolu'),
      description: t(
        'studio.tools.autopilot.desc',
        'Krediyi yükle, sınırı bir kez belirle ve motoru çalıştır — yaptığı her şey burada kayıtlı.',
      ),
    },
    calendar: {
      title: t('studio.tools.calendar.title', 'İçerik takvimi'),
      description: t(
        'studio.tools.calendar.desc',
        'Planlanmış gönderileri gör ve tek tıkla haftalık planı ürettir.',
      ),
    },
    create: {
      title: t('studio.tools.create.title', 'AI stüdyo'),
      description: t('studio.tools.create.desc', 'Gönderilerin için görsel ve video üret.'),
    },
    connections: {
      title: t('studio.tools.connections.title', 'Bağlantılar'),
      description: t(
        'studio.tools.connections.desc',
        'Reklam, sosyal ve mesajlaşma hesaplarını bağla veya yenile.',
      ),
    },
    money: {
      title: t('studio.tools.money.title', 'Para'),
      description: t(
        'studio.tools.money.desc',
        'Kim sana borçlu, sen neye abonesin, cüzdanda ne var — ayarlara gitmeden.',
      ),
    },
    ops: {
      title: t('studio.tools.ops.title', 'İşleyiş'),
      description: t(
        'studio.tools.ops.desc',
        'Otomasyonların çalıştı mı, teslimatlar düştü mü, bekleyen veri talebin var mı.',
      ),
    },
    audience: {
      title: t('studio.tools.audience.title', 'Kitle'),
      description: t(
        'studio.tools.audience.desc',
        'Listen nereden geliyor ve nasıl bölünüyor: AI önerileri, içe aktarım, segmentler.',
      ),
    },
    line: {
      title: t('studio.tools.line.title', 'İçerik hattı'),
      description: t(
        'studio.tools.line.desc',
        'Bir fikirden farklı açılarda konseptler; her partinin öneriden yayına kadar hâli, ve ne işe yaradığı.',
      ),
    },
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          // Wide on purpose: these are full working surfaces (an allocation
          // table, a month calendar), not a detail pane. The `max-w-sm` the
          // `right` variant defaults to would put the calendar in a column.
          className="flex w-full flex-col gap-4 sm:max-w-3xl lg:max-w-5xl"
          data-testid="studio-tools-drawer"
        >
          <SheetHeader className="shrink-0 pe-10">
            <SheetTitle>{meta[active].title}</SheetTitle>
            {/* The description is a promise about what you can do in here, so a
                refused tool must not keep making it — "connect or refresh your
                accounts" over a panel that will never show you one is worse than
                no description at all. */}
            <SheetDescription>
              {allowed
                ? meta[active].description
                : t(
                    'studio.tools.deniedDesc',
                    'Bu araç yönetici yetkisi gerektiriyor. Erişim için çalışma alanı yöneticinle konuş.',
                  )}
            </SheetDescription>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              {/**
               * The bug this header exists to close: `embedded` hides
               * BudgetAutopilotPage's PageHeader, and the PageHeader is where
               * "Edit budget" and "Enable Autopilot" live. On the live /studio
               * a workspace that ALREADY has a budget therefore has no path at
               * all to the budget dialog or the enable wizard — the empty state
               * carries the wizard CTA, and the empty state is exactly the case
               * that no longer applies. So the drawer provides both triggers
               * itself, driving the same two exported components the page does
               * rather than duplicating a line of their logic.
               *
               * Both triggers, in BOTH budget states. The enable trigger used
               * to be withheld when there was no budget, on the grounds that
               * the console's own empty state already carried one — but that
               * one mounts its wizard INSIDE the SheetContent subtree, which is
               * the nested-dialog arrangement the hoisted instances at the
               * bottom of this file exist to avoid. `embedded` now suppresses
               * the page's own dialog and wizard (the host supplies both), so
               * withholding the trigger here would leave the empty state with
               * no working CTA at all. One trigger, always hoisted.
               *
               * MANAGER-gated because both endpoints behind them are
               * (`POST /budget`, `POST /budget/quick-start`); a REP can read
               * this console but would only collect a 403 at the end of the
               * wizard.
               */}
              {active === 'autopilot' && canManage && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => setBudgetDialogOpen(true)}>
                    {currentBudget
                      ? t('studio.tools.editBudget', 'Bütçeyi düzenle')
                      : t('studio.tools.createBudget', 'Bütçe oluştur')}
                  </Button>
                  <Button size="sm" onClick={() => setWizardOpen(true)}>
                    <Sparkles className="me-1.5 h-4 w-4" aria-hidden="true" />
                    {t('studio.tools.enableAutopilot', 'Otomatik pilotu etkinleştir')}
                  </Button>
                </>
              )}

              {active === 'autopilot' && pendingApprovals > 0 && (
                <PendingApprovalsLink count={pendingApprovals} onReturn={() => onOpenChange(false)} />
              )}

              <DeepLinksMenu onNavigate={() => onOpenChange(false)} />
            </div>
          </SheetHeader>

          {/* The scroll lives here, not on the panel, so the header (and with
              it the budget triggers and the deep links) stays put while a long
              allocation table or a month of calendar scrolls underneath. */}
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="studio-tools-body">
            {/* Refused before anything is mounted or fetched. Not `return null`:
                the person typed (or bookmarked, or was sent) this URL and is
                owed a reason, and a blank drawer reads as a broken one. The
                lazy import is never reached either, so a REP does not even
                download the page they may not see. */}
            {!allowed && <ToolDenied />}

            {allowed && active === 'autopilot' && (
              <Lazy>
                {/* `hideApprovals`: the Studio's right rail renders the same
                    workspace-scoped ApprovalQueue. The same queue twice on one
                    screen is worse than either placement alone — two lists, one
                    of them stale the instant you act on the other. */}
                <BudgetAutopilotPage embedded hideApprovals />
              </Lazy>
            )}

            {allowed && active === 'line' && (
              <Lazy>
                {openedBatch ? (
                  <BatchDetail batchId={openedBatch} onClose={() => setOpenedBatch(null)} />
                ) : (
                  <ContentLinePanel onOpenBatch={setOpenedBatch} />
                )}
              </Lazy>
            )}

            {allowed && active === 'calendar' && (
              // No FeatureGate around this one: StudioCalendarTab already gates
              // the part that needs an entitlement (the weekly-plan CTA, which
              // provisions a SocialCampaign) and shows the calendar regardless.
              // Wrapping the whole tab would hide a read-only calendar that
              // every plan is entitled to.
              <Lazy>
                <StudioCalendarTab />
              </Lazy>
            )}

            {allowed && active === 'create' && (
              <SettledFeatureGate feature="mediaGen">
                <Lazy>
                  {/* Do NOT re-home AiStudioPage's "Add to post": it navigates
                      to /studio?view=tools&tab=campaigns&sub=planner carrying
                      `location.state.seedMedia`, that exact URL is pinned by
                      AiStudioPage.test.tsx, and a redirect would drop the
                      state — the generated media would simply vanish on the
                      way to the composer. */}
                  <AiStudioPage embedded />
                </Lazy>
              </SettledFeatureGate>
            )}

            {allowed && active === 'connections' && (
              <Lazy>
                <AccountCenterPage embedded />
              </Lazy>
            )}

            {/* PARA. Five surfaces that were five trips through the gear.
                The per-section gates are a SECOND, independent layer: the tool's
                MANAGER check above says who may open the stack at all, and says
                nothing about whether this workspace's plan includes invoicing or
                whether this manager is the agency's OWNER. */}
            {allowed && active === 'money' && (
              <div className="space-y-1">
                <Section
                  title={t('studio.tools.section.invoices', 'Faturalar')}
                  data-testid="tool-section-invoices"
                  defaultOpen
                >
                  <SettledFeatureGate feature="invoicing">
                    <InvoicesPage embedded />
                  </SettledFeatureGate>
                </Section>
                <Section
                  title={t('studio.tools.section.subscriptions', 'Abonelikler')}
                  data-testid="tool-section-subscriptions"
                >
                  <SettledFeatureGate feature="invoicing">
                    <SubscriptionsPage embedded />
                  </SettledFeatureGate>
                </Section>
                <Section
                  title={t('studio.tools.section.billing', 'Kredi ve paket')}
                  data-testid="tool-section-billing"
                >
                  {/* No `embedded` yet: the prop is another lane's edit to
                      billing/index.tsx. Passing nothing is correct both before
                      and after it lands — the only cost until then is the
                      page's own header inside the section. */}
                  <BillingPage />
                </Section>
                <Section
                  title={t('studio.tools.section.coupons', 'Kuponlar')}
                  data-testid="tool-section-coupons"
                >
                  <CouponsPage embedded />
                </Section>
                {/* ownerOnly + agencyOnly, exactly as navigation.ts states it
                    for /agency/rebilling. `isAgency` fails CLOSED while the
                    workspace profile is in flight, so this never flashes for a
                    standalone workspace. */}
                {isAgency && hasMarketingRole(user?.role, MarketingRole.OWNER) && (
                  <Section
                    title={t('studio.tools.section.rebilling', 'Yeniden faturalama')}
                    data-testid="tool-section-rebilling"
                  >
                    <RebillingPage embedded />
                  </Section>
                )}
              </div>
            )}

            {/* İŞLEYİŞ — did the machinery run, and is anything waiting on me. */}
            {allowed && active === 'ops' && (
              <div className="space-y-1">
                <Section
                  title={t('studio.tools.section.workflows', "Workflow'lar")}
                  data-testid="tool-section-workflows"
                  defaultOpen
                >
                  <SettledFeatureGate feature="workflows">
                    {/* The builder is a `fullBleed` route of its own, so opening
                        it leaves this screen entirely. `onNavigate` drops the
                        `?tool=ops` first (the host's close is a `replace`), so
                        coming back lands on a plain /studio instead of
                        reopening a drawer nobody asked for. */}
                    <AutomationsListPage embedded onNavigate={() => onOpenChange(false)} />
                  </SettledFeatureGate>
                </Section>
                <Section
                  title={t('studio.tools.section.triggerLinks', 'Tetikleyici linkler')}
                  data-testid="tool-section-trigger-links"
                >
                  <TriggerLinksPage embedded />
                </Section>
                <Section
                  title={t('studio.tools.section.webhooks', 'Webhook teslimatları')}
                  data-testid="tool-section-webhooks"
                >
                  <WebhooksPage embedded />
                </Section>
                <Section
                  title={t('studio.tools.section.mcpSessions', 'Claude oturumları')}
                  data-testid="tool-section-mcp-sessions"
                >
                  <McpSessionsSection />
                </Section>
                <Section
                  title={t('studio.tools.section.dataRequests', 'Veri talepleri (KVKK/GDPR)')}
                  data-testid="tool-section-data-requests"
                >
                  <ComplianceRequestsSection />
                </Section>
              </div>
            )}

            {/* KİTLE — where the list comes from and how it is carved up. */}
            {allowed && active === 'audience' && (
              <div className="space-y-1">
                <Section
                  title={t('studio.tools.section.researchQueue', 'AI aday önerileri')}
                  data-testid="tool-section-research-queue"
                  defaultOpen
                >
                  <SettledFeatureGate feature="research">
                    <ResearchSuggestionsPage embedded />
                  </SettledFeatureGate>
                </Section>
                <Section
                  title={t('studio.tools.section.researchProfiles', 'Araştırma profilleri')}
                  data-testid="tool-section-research-profiles"
                >
                  <SettledFeatureGate feature="research">
                    <ResearchSettingsPage embedded />
                  </SettledFeatureGate>
                </Section>
                <Section
                  title={t('studio.tools.section.import', 'İçe aktarım')}
                  data-testid="tool-section-import"
                >
                  <ImportWizardPage embedded />
                </Section>
                <Section
                  title={t('studio.tools.section.segments', 'Segmentler')}
                  data-testid="tool-section-segments"
                >
                  <SegmentsPage embedded />
                </Section>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Rendered outside <Sheet> on purpose: a Radix dialog nested inside
          another dialog's content fights it for the focus trap, and closing the
          inner one can dismiss both. These are the console's own components,
          driven from here — same props, same refresh, no duplicated logic.
          Hoisting them here only works because `embedded` stops the page from
          mounting its own pair inside the SheetContent subtree; otherwise the
          empty state's CTA would open the nested copy this arrangement exists
          to avoid, in the one state where it is the most prominent button on
          the panel. */}
      <BudgetDialog
        open={budgetDialogOpen}
        onOpenChange={setBudgetDialogOpen}
        budget={currentBudget}
        onSaved={() => {
          setBudgetDialogOpen(false);
          refreshBudget();
        }}
      />
      <EnableAutopilotWizard open={wizardOpen} onOpenChange={setWizardOpen} onProvisioned={refreshBudget} />
    </>
  );
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * One row of a recurring tool's stack: a heading, and a whole page under it
 * that does not exist until the heading is clicked.
 *
 * The `Suspense` is INSIDE the disclosure rather than around the stack, so a
 * section still downloading its chunk shows a fallback in its own row instead
 * of replacing every heading above and below it with one spinner.
 */
function Section({
  title,
  defaultOpen,
  children,
  'data-testid': testId,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <Disclosure title={title} defaultOpen={defaultOpen} data-testid={testId}>
      <Lazy>{children}</Lazy>
    </Disclosure>
  );
}

/**
 * The refusal a REP gets on `?tool=create` or `?tool=connections`.
 *
 * Deliberately shaped like the router's own outcome and not like a 403: the
 * backend would refuse too, but by then four requests have gone out and the
 * global toaster has shouted four times. This says the same thing once, before
 * anything is fetched, and names WHO can lift it — "ask an admin" is the only
 * next step a REP actually has, so it is the only one offered. No retry button:
 * nothing here is going to change on a retry.
 */
function ToolDenied() {
  const { t } = useTranslation('marketing');
  return (
    <EmptyState
      data-testid="studio-tool-denied"
      icon={<Lock className="h-5 w-5" />}
      title={t('studio.tools.denied', 'Bu araç yöneticilere açık')}
      description={t(
        'studio.tools.deniedDesc',
        'Bu araç yönetici yetkisi gerektiriyor. Erişim için çalışma alanı yöneticinle konuş.',
      )}
    />
  );
}

/**
 * A pointer to the approvals queue, not a second copy of it.
 *
 * `hideApprovals` hands the queue to the Studio's right rail so it is not
 * rendered twice — but `<Sheet>` is a MODAL, so while this console is open the
 * rail sits behind an overlay and cannot be reached or even read. The state in
 * which someone is most likely to be weighing a pending SPEND approval (they
 * are looking at the budget console) was the one state where the queue was
 * nowhere on screen.
 *
 * Of the two ways out, this is the one that does not reintroduce the problem
 * `hideApprovals` was added for. Putting the standalone queue back inside the
 * console would mean two live, independently-mutating lists of the same
 * workspace-scoped rows — the moment you approve on one, the other is stale —
 * and the argument that "the duplicate is invisible anyway" holds only until
 * the drawer closes, at which point both are on screen at once. A count is not
 * a copy: it cannot go stale in a way that matters (it shares the rail's exact
 * `['pending-approvals']` entry, so it IS the rail's number), it cannot be
 * acted on by mistake, and clicking it closes the drawer and puts the person
 * in front of the one real queue.
 */
function PendingApprovalsLink({ count, onReturn }: { count: number; onReturn: () => void }) {
  const { t } = useTranslation('marketing');
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onReturn}
      data-testid="drawer-pending-approvals"
      title={t('studio.tools.approvalsHint', 'Onay listesi bu panelin arkasında — kapatıp dön.')}
    >
      <Badge tone="warning" size="sm" className="me-1.5">
        {count}
      </Badge>
      {t('studio.tools.approvalsWaiting', 'onay bekliyor')}
    </Button>
  );
}

/**
 * FeatureGate that does not flash.
 *
 * `useEntitlements` fails CLOSED — while its billing-summary query is in
 * flight `has()` is false — so a bare FeatureGate paints the upgrade callout
 * for a beat and then swaps in the tool. On a drawer that a person just opened
 * on purpose, that beat reads as "you do not have this", and some of them will
 * close it again before the swap. Skeleton until the answer is actually known,
 * then the real gate. Shares the hook's query key, so this costs no request.
 */
function SettledFeatureGate({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  const { isLoading } = useEntitlements();
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  return (
    <FeatureGate feature={feature} fallback={<UpgradeCallout />}>
      {children}
    </FeatureGate>
  );
}

/**
 * Every surface the old tools hub reached that the new Studio does not.
 *
 * Plain `<Link>`s, not buttons that push history: these are the fallback path,
 * and a middle-click / open-in-new-tab has to work on them. The `?view=tools`
 * shape is kept verbatim because that is where those surfaces genuinely live —
 * `GrowthStudioPage` renders its full-page `ToolsSurface` for exactly that
 * query, and each `tab`/`sub` pair below selects one of its panels. These are
 * NOT deep links into this drawer; rewriting them to `?tool=` would point at a
 * four-entry union that does not contain a single one of them.
 */
const DEEP_LINKS: Array<{ to: string; key: string; label: string; role?: MarketingRole }> = [
  { to: '/studio?view=tools&tab=campaigns&sub=standard', key: 'studio.tools.link.campaigns', label: 'Kampanyalar' },
  { to: '/studio?view=tools&tab=campaigns&sub=social', key: 'studio.tools.link.socialCampaigns', label: 'Sosyal kampanyalar' },
  // MANAGER, like the four /-routes below: `SocialPlannerController` is
  // `@MarketingRoles('MANAGER')` at class level, so a rep who followed this row
  // reached a table whose every request 403s. The tab itself also refuses now
  // (ManagerTab) — this is the half that stops offering the door.
  { to: '/studio?view=tools&tab=campaigns&sub=planner', key: 'studio.tools.link.planner', label: 'Sosyal planlayıcı', role: MarketingRole.MANAGER },
  { to: '/studio?view=tools&tab=trends', key: 'studio.tools.link.trends', label: 'Trendler' },
  /**
   * UGC Personas stays a deep link, and this is the note that says so on
   * purpose rather than by omission.
   *
   * The 2026-09 audit read this row as the page's only door and called it
   * buried — a dropdown, inside a drawer, that you can only open by first
   * opening the drawer on some unrelated tool. Half of that is true. The other
   * half is that this is not the only door: `?view=tools&tab=create` renders a
   * two-tab strip whose second tab is named "UGC Personaları" in full, so the
   * page is also one click inside a surface the permanent tools menu links to
   * by name. Two named paths, and `GrowthStudioPage.test.tsx` now pins the
   * second one so it cannot quietly become one.
   *
   * Promoting it to a `?tool=` of its own — the obvious fix — was rejected on
   * proportion. Every other row in this list is in exactly the same position:
   * Kampanyalar, Trendler, Raporlar and Strateji are all tabs of that same
   * surface plus a row here, and all four are used far more often than a
   * persona library a workspace configures once and then draws on from inside
   * the AI Studio. Giving personas a front-door menu entry would make it the
   * single most prominent thing on this screen that has no entry in the
   * product's navigation at all, ahead of four destinations that do. If this
   * list's depth is the problem, it is the LIST's problem and the fix is the
   * whole list, not the one row an audit happened to open.
   */
  { to: '/studio?view=tools&tab=create&sub=personas', key: 'studio.tools.link.personas', label: 'UGC personaları' },
  // The four routes App.tsx puts behind `requiredRole={MarketingRole.MANAGER}`.
  // Unlike the drawer's own tools these are real navigations, so the router does
  // refuse them correctly — a REP who clicks one is bounced to /home. That is a
  // dead row, not a hole: it offers a door that closes in your face. Filtered for
  // the same reason StudioToolsMenu filters `connections`, and no more strongly,
  // because the gate that matters is still App.tsx's.
  { to: '/email-templates', key: 'studio.tools.link.emailTemplates', label: 'E-posta şablonları', role: MarketingRole.MANAGER },
  { to: '/reviews', key: 'studio.tools.link.reviews', label: 'Yorumlar', role: MarketingRole.MANAGER },
  { to: '/affiliates', key: 'studio.tools.link.affiliates', label: 'Ortaklar', role: MarketingRole.MANAGER },
  { to: '/reports', key: 'studio.tools.link.reports', label: 'Raporlar' },
  { to: '/studio/strategy', key: 'studio.tools.link.strategy', label: 'Strateji' },
  { to: '/accounts', key: 'studio.tools.link.connections', label: 'Bağlantılar', role: MarketingRole.MANAGER },
];

function DeepLinksMenu({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation('marketing');
  const role = useMarketingAuthStore((s) => s.user?.role);
  const links = DEEP_LINKS.filter((l) => !l.role || hasMarketingRole(role, l.role));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          {t('studio.tools.more', 'Diğer araçlar')}
          <ChevronDown className="ms-1 h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>{t('studio.tools.more', 'Diğer araçlar')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {links.map((l) => (
          <DropdownMenuItem key={l.to} asChild onSelect={onNavigate}>
            <Link to={l.to}>{t(l.key, l.label)}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
