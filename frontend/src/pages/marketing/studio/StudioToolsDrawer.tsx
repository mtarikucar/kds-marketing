import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, Sparkles } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/Skeleton';
import { FeatureGate } from '@/components/ui/access-gates';
import { useEntitlements } from '@/features/marketing/hooks/useEntitlements';
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

/**
 * The tools that used to be tabs on `/studio`. Deliberately a tiny closed
 * union: `StudioOneScreen` decides which one is open — it is the thing that
 * reads `?tool=` — and this component only renders what it is told. Keeping
 * `useSearchParams` out of here is what lets the same drawer be driven by a
 * URL, by a button, or by a test.
 *
 * Nothing maps the older `?view=tools&tab=…` links onto this drawer, and no
 * code here should be written as though something did. Those URLs are read by
 * `GrowthStudioPage`, which renders the separate full-page `ToolsSurface` for
 * them; the drawer's menu below merely LINKS to that surface. Deleting
 * `ToolsSurface` on the belief that this drawer had absorbed it would take
 * seven live destinations with it.
 */
export type StudioTool = 'autopilot' | 'calendar' | 'create' | 'connections';

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

  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  /**
   * A drawer opened with no tool named still has to render something — Radix
   * keeps the panel mounted through its close animation, and the page may hand
   * us `null` for a `?tab=` value that is not one of ours. The Autopilot is the
   * right default: it is what `/studio` showed before this screen existed.
   */
  const active: StudioTool = tool ?? 'autopilot';

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
            <SheetDescription>{meta[active].description}</SheetDescription>

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
            {active === 'autopilot' && (
              <Lazy>
                {/* `hideApprovals`: the Studio's right rail renders the same
                    workspace-scoped ApprovalQueue. The same queue twice on one
                    screen is worse than either placement alone — two lists, one
                    of them stale the instant you act on the other. */}
                <BudgetAutopilotPage embedded hideApprovals />
              </Lazy>
            )}

            {active === 'calendar' && (
              // No FeatureGate around this one: StudioCalendarTab already gates
              // the part that needs an entitlement (the weekly-plan CTA, which
              // provisions a SocialCampaign) and shows the calendar regardless.
              // Wrapping the whole tab would hide a read-only calendar that
              // every plan is entitled to.
              <Lazy>
                <StudioCalendarTab />
              </Lazy>
            )}

            {active === 'create' && (
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

            {active === 'connections' && (
              <Lazy>
                <AccountCenterPage embedded />
              </Lazy>
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
const DEEP_LINKS: Array<{ to: string; key: string; label: string }> = [
  { to: '/studio?view=tools&tab=campaigns&sub=standard', key: 'studio.tools.link.campaigns', label: 'Kampanyalar' },
  { to: '/studio?view=tools&tab=campaigns&sub=social', key: 'studio.tools.link.socialCampaigns', label: 'Sosyal kampanyalar' },
  { to: '/studio?view=tools&tab=campaigns&sub=planner', key: 'studio.tools.link.planner', label: 'Sosyal planlayıcı' },
  { to: '/studio?view=tools&tab=trends', key: 'studio.tools.link.trends', label: 'Trendler' },
  { to: '/studio?view=tools&tab=create&sub=personas', key: 'studio.tools.link.personas', label: 'UGC personaları' },
  { to: '/email-templates', key: 'studio.tools.link.emailTemplates', label: 'E-posta şablonları' },
  { to: '/reviews', key: 'studio.tools.link.reviews', label: 'Yorumlar' },
  { to: '/affiliates', key: 'studio.tools.link.affiliates', label: 'Ortaklar' },
  { to: '/reports', key: 'studio.tools.link.reports', label: 'Raporlar' },
  { to: '/studio/strategy', key: 'studio.tools.link.strategy', label: 'Strateji' },
  { to: '/accounts', key: 'studio.tools.link.connections', label: 'Bağlantılar' },
];

function DeepLinksMenu({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation('marketing');
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
        {DEEP_LINKS.map((l) => (
          <DropdownMenuItem key={l.to} asChild onSelect={onNavigate}>
            <Link to={l.to}>{t(l.key, l.label)}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
