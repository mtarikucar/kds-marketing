import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Wallet, Gauge, PiggyBank, ShieldAlert, Sparkles, Check, X, Play, Pause as PauseIcon, TrendingUp, CreditCard } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Switch } from '@/components/ui/Switch';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { fmtDateTime } from '../../../features/marketing/utils/format';
import {
  listGrowthBudgets,
  getGrowthBudget,
  setBudgetKillSwitch,
  setBudgetStatus,
  setAutonomyLevel,
  setContentAutoPublish,
  proposeBudget,
  listAutopilotRuns,
  listPendingApprovals,
  approveRequest,
  applyReallocation,
  rejectRequest,
  getWalletState,
  listBudgetActivity,
  walletTopup,
  type GrowthBudget,
  type ProposeResult,
} from '../../../features/marketing/api/growthBudget.service';
import { BudgetDialog } from './BudgetDialog';
import { EnableAutopilotWizard } from './EnableAutopilotWizard';
import { ActivityFeed } from './ActivityFeed';
import { money, num, deriveGrowthMultiple, pickLatestObjective, pickTopupProvider } from './autopilotMath';

/**
 * Growth Autopilot console (spec G). ONE control surface: load credit, set the
 * cap + goal once, flip the Autopilot switch — then watch the Activity Log.
 * The only interrupts are Pause and the kill-switch; an ASSISTED budget keeps
 * the classic approval queue, an armed AUTONOMOUS budget never asks.
 */
export default function BudgetAutopilotPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const budgetsQ = useQuery({ queryKey: ['growth-budgets'], queryFn: listGrowthBudgets });
  const budgets = budgetsQ.data ?? [];
  const current = budgets[0]; // most recent period first (backend orders desc)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['growth-budgets'] });
    qc.invalidateQueries({ queryKey: ['growth-wallet'] });
    // Also refresh the per-budget detail query (['growth-budget', id]); BudgetDetail
    // prefers detailQ.data over the list summary, so without this a dialog/wizard
    // save leaves the detail view (monthly budget, scope, ROAS, allocations) stale.
    qc.invalidateQueries({ queryKey: ['growth-budget'] });
  };

  return (
    <div className="space-y-6">
      {!embedded && (
      <PageHeader
        title={t('autopilot.title', 'Growth Autopilot')}
        description={t('autopilot.subtitle', 'Load credit, set your caps once, flip it on — the engine spends it where it makes you the most sales, and logs everything it does.')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>
              {current ? t('budget.edit', 'Edit budget') : t('budget.create', 'Create budget')}
            </Button>
            {/* With no budget the empty state carries the single CTA — never two. */}
            {current && (
              <Button onClick={() => setWizardOpen(true)}>
                <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {t('autopilot.enableCta', 'Enable Autopilot')}
              </Button>
            )}
          </div>
        }
      />
      )}

      <QueryStateBoundary isLoading={budgetsQ.isLoading} isError={budgetsQ.isError} onRetry={() => budgetsQ.refetch()}>
        {!current ? (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title={t('budget.empty.title', 'No growth budget yet')}
            description={t('autopilot.empty.desc', 'One click sets up everything: your credit wallet, a monthly budget and allocations for every channel you have connected — then the engine takes it from there.')}
            action={<Button onClick={() => setWizardOpen(true)}>{t('autopilot.enableCta', 'Enable Autopilot')}</Button>}
          />
        ) : (
          <BudgetDetail budget={current} />
        )}
      </QueryStateBoundary>

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        budget={current}
        onSaved={() => {
          setDialogOpen(false);
          refresh();
        }}
      />
      <EnableAutopilotWizard open={wizardOpen} onOpenChange={setWizardOpen} onProvisioned={refresh} />
    </div>
  );
}

function BudgetDetail({ budget: summary }: { budget: GrowthBudget }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [flagBlocked, setFlagBlocked] = useState(false);
  const [activeTab, setActiveTab] = useState('allocation');

  const detailQ = useQuery({ queryKey: ['growth-budget', summary.id], queryFn: () => getGrowthBudget(summary.id) });
  const budget = detailQ.data ?? summary;
  const allocations = budget.allocations ?? [];
  const currency = budget.currency;

  const walletQ = useQuery({ queryKey: ['growth-wallet'], queryFn: getWalletState });
  const activityQ = useQuery({ queryKey: ['budget-activity', budget.id], queryFn: () => listBudgetActivity(budget.id) });

  const planned = useMemo(() => allocations.reduce((s, a) => s + num(a.plannedAmount), 0), [allocations]);
  const spent = useMemo(() => allocations.reduce((s, a) => s + num(a.spentAmount), 0), [allocations]);
  const total = num(budget.totalAmount);
  const spentPct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 0;

  // Hero "Growth Multiple" (spec D15): attributed revenue ÷ engine spend,
  // derived from each channel's latest CRM-reconciled avgRoas snapshot.
  const growth = useMemo(
    () => deriveGrowthMultiple(allocations, pickLatestObjective(activityQ.data)),
    [allocations, activityQ.data],
  );
  const walletBalance = num(walletQ.data?.balance);
  const armed = budget.autonomyLevel === 'AUTONOMOUS';

  // Arming removes the Approvals tab. If it was the active tab, Radix (which
  // holds the selected value internally) would be left pointing at a tab that no
  // longer exists → a blank body with no active underline. Fall back to Allocation.
  useEffect(() => {
    if (armed && activeTab === 'approvals') setActiveTab('allocation');
  }, [armed, activeTab]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['growth-budget', budget.id] });
    qc.invalidateQueries({ queryKey: ['growth-budgets'] });
  };

  const kill = useMutation({
    mutationFn: (on: boolean) => setBudgetKillSwitch(budget.id, on),
    onSuccess: (_data, on) => {
      invalidate();
      toast.success(
        on
          ? t('budget.killOnToast', 'Kill-switch on — all autonomy paused')
          : t('budget.killOffToast', 'Kill-switch off — autonomy resumed'),
      );
    },
    onError: () => toast.error(t('budget.killError', 'Could not update the kill-switch')),
  });

  const pauseResume = useMutation({
    mutationFn: (status: 'ACTIVE' | 'PAUSED') => setBudgetStatus(budget.id, status),
    onSuccess: (_d, status) => {
      invalidate();
      toast.success(
        status === 'PAUSED'
          ? t('autopilot.pausedToast', 'Engine paused — nothing moves until you resume')
          : t('autopilot.resumedToast', 'Engine resumed'),
      );
    },
    onError: () => toast.error(t('autopilot.statusError', 'Could not change the engine status')),
  });

  const arm = useMutation({
    mutationFn: (level: 'AUTONOMOUS' | 'ASSISTED') => setAutonomyLevel(budget.id, level),
    onSuccess: (_d, level) => {
      invalidate();
      toast.success(
        level === 'AUTONOMOUS'
          ? t('autopilot.armedToast', 'Autopilot armed — the engine now optimizes on its own. You will never be asked; pause any time.')
          : t('autopilot.disarmedToast', 'Autopilot disarmed — proposals now wait for your approval.'),
      );
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '';
      if (/not enabled/i.test(msg)) {
        setFlagBlocked(true);
      } else {
        toast.error(t('autopilot.armError', 'Could not change the autonomy level'));
      }
    },
  });

  const contentAuto = useMutation({
    mutationFn: (on: boolean) => setContentAutoPublish(budget.id, on),
    onSuccess: (_d, on) => {
      invalidate();
      toast.success(
        on
          ? t('autopilot.contentAutoOnToast', 'Content auto-publishes now — no review queue.')
          : t('autopilot.contentAutoOffToast', 'Content will be shown before it posts (auto-publishes unless you reject it).'),
      );
    },
    onError: () => toast.error(t('autopilot.contentAutoError', 'Could not change the content setting')),
  });

  const topup = useMutation({
    mutationFn: (amount: number) =>
      walletTopup({ amount, provider: pickTopupProvider(walletQ.data?.currency ?? currency) }),
    onSuccess: ({ handle }) => {
      const url = (handle as { url?: string; iframeUrl?: string }).url ?? (handle as { iframeUrl?: string }).iframeUrl;
      if (url) window.open(url, '_blank', 'noopener');
      toast.success(t('autopilot.topupStarted', 'Top-up checkout opened — credit lands after payment.'));
    },
    onError: () => toast.error(t('autopilot.topupError', 'Could not start the top-up')),
  });

  const statusTone: Record<string, 'success' | 'warning' | 'danger'> = { ACTIVE: 'success', PAUSED: 'warning', KILLED: 'danger' };

  return (
    <>
      <QueryStateBoundary isLoading={detailQ.isLoading} isError={detailQ.isError} onRetry={() => detailQ.refetch()}>
        <div className="space-y-6">
          {budget.killSwitch && (
            <Callout tone="danger" title={t('budget.killedTitle', 'Kill-switch is ON')} icon={<ShieldAlert className="h-4 w-4" />}>
              {t('budget.killedDesc', 'All autonomous activity is halted. No proposals or spend until you turn it off.')}
            </Callout>
          )}

          {/* Hero strip (spec D15): the one number that proves the engine works. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t('autopilot.hero.multiple', 'Growth Multiple')}
              value={growth.multiple != null ? `${growth.multiple.toFixed(2)}×` : '—'}
              icon={<TrendingUp className="h-4 w-4" />}
            />
            <StatCard label={t('autopilot.hero.loaded', 'Credit loaded')} value={money(walletBalance + growth.spend, currency)} icon={<CreditCard className="h-4 w-4" />} />
            <StatCard label={t('autopilot.hero.spent', 'Credit spent')} value={money(growth.spend, currency)} icon={<Gauge className="h-4 w-4" />} delta={{ direction: spentPct > 90 ? 'up' : 'flat', value: `${spentPct}%` }} />
            <StatCard label={t('autopilot.hero.balance', 'Credit balance')} value={money(walletBalance, currency)} icon={<Wallet className="h-4 w-4" />} />
          </div>

          {/* THE control row: one switch, two interrupts — the user is never asked anything else. */}
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className={`h-4 w-4 ${armed ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
                  {t('autopilot.switch', 'Autopilot')}
                  <Switch
                    checked={armed}
                    disabled={arm.isPending || flagBlocked || budget.killSwitch}
                    onCheckedChange={(v) => arm.mutate(v ? 'AUTONOMOUS' : 'ASSISTED')}
                    aria-label={t('autopilot.switch', 'Autopilot')}
                  />
                </label>
                <Badge tone={statusTone[budget.status] ?? 'neutral'}>{t(`budget.status.${budget.status}`, budget.status)}</Badge>
                <span className="text-sm text-muted-foreground">{budget.periodKey}</span>
                {budget.targetRoas && (
                  <Badge tone="neutral">{t('budget.targetRoas', 'Target ROAS')} {num(budget.targetRoas)}x</Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => topup.mutate(Math.max(100, Math.round(total / 3)))}
                  disabled={topup.isPending || walletQ.isLoading}
                >
                  <CreditCard className="mr-1 h-4 w-4" aria-hidden="true" />{t('autopilot.topup', 'Top up')}
                </Button>
                {budget.status === 'PAUSED' ? (
                  <Button size="sm" onClick={() => pauseResume.mutate('ACTIVE')} disabled={pauseResume.isPending}>
                    <Play className="mr-1 h-4 w-4" aria-hidden="true" />{t('autopilot.resume', 'Resume')}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => pauseResume.mutate('PAUSED')} disabled={pauseResume.isPending}>
                    <PauseIcon className="mr-1 h-4 w-4" aria-hidden="true" />{t('autopilot.pause', 'Pause')}
                  </Button>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <ShieldAlert className={`h-4 w-4 ${budget.killSwitch ? 'text-danger' : 'text-muted-foreground'}`} aria-hidden="true" />
                  {t('budget.killSwitch', 'Kill-switch')}
                  <Switch
                    checked={budget.killSwitch}
                    disabled={kill.isPending}
                    onCheckedChange={(v) => (v ? setKillConfirmOpen(true) : kill.mutate(false))}
                    aria-label={t('budget.killSwitch', 'Kill-switch')}
                  />
                </label>
              </div>
            </CardContent>
          </Card>

          {flagBlocked && (
            <Callout tone="warning" title={t('autopilot.flagOffTitle', 'Autonomous mode unavailable')}>
              {t('autopilot.flagOff', 'Autonomous mode is not enabled on this platform yet — ask your platform admin.')}
            </Callout>
          )}

          {/* Content-arm safety: autonomous PUBLIC posting can't be undone by
              the kill-switch, so by default the engine shows each post before
              it goes (auto-publishes unless rejected). Only shown when armed. */}
          {armed && (
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('autopilot.contentAuto.title', 'Auto-publish content')}</p>
                  <p className="text-xs text-muted-foreground">
                    {budget.contentAutoPublish
                      ? t('autopilot.contentAuto.onDesc', 'The engine posts to your accounts with no review — pure hands-off.')
                      : t('autopilot.contentAuto.offDesc', 'Each post is shown in Approvals first and auto-publishes unless you reject it — posting can’t be undone.')}
                  </p>
                </div>
                <Switch
                  checked={budget.contentAutoPublish}
                  disabled={contentAuto.isPending || budget.killSwitch}
                  onCheckedChange={(v) => contentAuto.mutate(v)}
                  aria-label={t('autopilot.contentAuto.title', 'Auto-publish content')}
                />
              </CardContent>
            </Card>
          )}

          {/* Mode-1 honesty (spec D3 / guardrail 7): never imply the platform pays the ad network. */}
          <p className="text-xs text-muted-foreground">
            {t('autopilot.mode1', 'Ad spend is billed by Meta/TikTok on your connected ad account; your credit governs how much the engine commits.')}
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={t('budget.stat.total', 'Monthly budget')} value={money(total, currency)} icon={<Wallet className="h-4 w-4" />} />
            <StatCard label={t('budget.stat.spent', 'Spent so far')} value={money(spent, currency)} icon={<Gauge className="h-4 w-4" />} />
            <div title={t('budget.stat.reserveTip', 'Share of the budget held back for learning — never spent on proven channels.')}>
              <StatCard label={t('budget.stat.reserve', 'Exploration reserve')} value={`${budget.explorationPct}%`} icon={<PiggyBank className="h-4 w-4" />} />
            </div>
            <div title={t('budget.stat.scopeTip', 'Holistic paces every channel and conversation into the budget; Ads only limits the autopilot to paid ad spend.')}>
              <StatCard label={t('budget.stat.scope', 'Scope')} value={budget.scope === 'AD_ONLY' ? t('budget.scope.adOnly', 'Ads only') : t('budget.scope.holistic', 'Holistic')} />
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="allocation">{t('budget.tab.allocation', 'Allocation')}</TabsTrigger>
              <TabsTrigger value="activity">{t('autopilot.tab.activity', 'Activity')}</TabsTrigger>
              {!armed && <TabsTrigger value="approvals">{t('budget.tab.approvals', 'Approvals')}</TabsTrigger>}
              <TabsTrigger value="history">{t('budget.tab.history', 'History')}</TabsTrigger>
            </TabsList>

            <TabsContent value="allocation" className="pt-4">
              <AllocationTab budget={budget} allocations={allocations} planned={planned} />
            </TabsContent>
            <TabsContent value="activity" className="pt-4">
              <QueryStateBoundary isLoading={activityQ.isLoading} isError={activityQ.isError} onRetry={() => activityQ.refetch()}>
                <ActivityFeed items={activityQ.data ?? []} currency={currency} />
              </QueryStateBoundary>
            </TabsContent>
            {!armed && (
              <TabsContent value="approvals" className="pt-4">
                <ApprovalsTab />
              </TabsContent>
            )}
            <TabsContent value="history" className="pt-4">
              <HistoryTab budgetId={budget.id} />
            </TabsContent>
          </Tabs>
        </div>
      </QueryStateBoundary>

      <ConfirmDialog
        open={killConfirmOpen}
        onOpenChange={setKillConfirmOpen}
        tone="danger"
        title={t('budget.killConfirm.title', 'Turn on the kill-switch?')}
        description={t('budget.killConfirm.desc', 'This halts all autonomous activity — no proposals or spend until you turn it back off.')}
        confirmLabel={t('budget.killConfirm.confirm', 'Turn on kill-switch')}
        cancelLabel={t('common.cancel', 'Cancel')}
        loading={kill.isPending}
        onConfirm={() => {
          kill.mutate(true);
          setKillConfirmOpen(false);
        }}
      />
    </>
  );
}

const CHANNEL_LABEL: Record<string, string> = {
  META: 'Meta', TIKTOK: 'TikTok', GOOGLE: 'Google', LINKEDIN: 'LinkedIn',
  CONTENT: 'Content', SMS: 'SMS', VOICE: 'Voice', WHATSAPP: 'WhatsApp',
};

function AllocationTab({ budget, allocations, planned }: { budget: GrowthBudget; allocations: GrowthBudget['allocations']; planned: number }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [proposal, setProposal] = useState<ProposeResult | null>(null);
  const currency = budget.currency;

  const propose = useMutation({
    mutationFn: () => proposeBudget(budget.id),
    onSuccess: (r) => {
      setProposal(r);
      if (r.status === 'SKIPPED') toast.info(t('budget.proposeSkipped', 'Skipped: {{reason}}', { reason: r.reason ?? '' }));
      else if (r.plan?.noop) toast.info(t('budget.proposeNoop', 'No change recommended right now'));
      else toast.success(t('budget.proposeDone', 'Shadow proposal ready — review it in Approvals'));
      qc.invalidateQueries({ queryKey: ['pending-approvals'] });
      qc.invalidateQueries({ queryKey: ['autopilot-runs', budget.id] });
    },
    onError: () => toast.error(t('budget.proposeError', 'Could not run a proposal')),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('budget.plannedOf', '{{planned}} of {{total}} allocated across {{n}} channel(s)', {
            planned: money(planned, currency), total: money(budget.totalAmount, currency), n: allocations?.length ?? 0,
          })}
        </p>
        <Button
          variant="secondary"
          onClick={() => propose.mutate()}
          disabled={propose.isPending || budget.killSwitch}
          title={t('budget.proposeNowTip', 'Runs a simulation only — proposes reallocations for your approval. No money moves.')}
        >
          <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {propose.isPending ? t('budget.proposing', 'Proposing…') : t('budget.proposeNow', 'Propose now (shadow)')}
        </Button>
      </div>

      {!allocations?.length ? (
        <EmptyState
          icon={<Wallet className="h-5 w-5" />}
          title={t('budget.noAlloc.title', 'No channel allocations yet')}
          description={t('budget.noAlloc.desc', 'Add a channel and a starting amount, then run a shadow proposal to see how the autopilot would rebalance it.')}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <THead>
              <TR>
                <TH>{t('budget.col.channel', 'Channel')}</TH>
                <TH numeric>{t('budget.col.planned', 'Planned')}</TH>
                <TH numeric>{t('budget.col.spent', 'Spent')}</TH>
                <TH numeric title={t('budget.col.mroasTip', 'Marginal ROAS — revenue returned per extra 1 TRY spent on this channel right now.')}>
                  {t('budget.col.mroas', 'Marginal ROAS')}
                </TH>
              </TR>
            </THead>
            <TBody>
              {allocations.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{CHANNEL_LABEL[a.channel] ?? a.channel}</TD>
                  <TD numeric>{money(a.plannedAmount, currency)}</TD>
                  <TD numeric className="text-muted-foreground">{money(a.spentAmount, currency)}</TD>
                  <TD numeric>{a.marginalRoas ? `${num(a.marginalRoas).toFixed(2)}x` : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {proposal?.plan && !proposal.plan.noop && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('budget.proposal.title', 'Proposed reallocation (simulation)')}</CardTitle>
            <CardDescription>
              {t('budget.proposal.desc', 'Pool {{pool}} · reserve {{reserve}} held for learning. Enqueued for your approval — nothing moved.', {
                pool: money(proposal.plan.pool, currency), reserve: money(proposal.plan.reserve, currency),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {proposal.plan.allocations.filter((c) => Math.abs(c.after - c.before) >= 0.01).map((c) => (
              <div key={`${c.channel}-${c.campaignRef}`} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-sm">
                <span className="font-medium">{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                <span className="flex items-center gap-2 tabular-nums">
                  <span className="text-muted-foreground">{money(c.before, currency)}</span>
                  <span aria-hidden>→</span>
                  <span className="font-medium">{money(c.after, currency)}</span>
                  <Badge tone={c.after >= c.before ? 'success' : 'warning'}>{c.deltaPct > 0 ? '+' : ''}{c.deltaPct}%</Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ApprovalsTab() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pending-approvals'], queryFn: listPendingApprovals });
  const [confirmItem, setConfirmItem] = useState<{ id: string; kind: string } | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pending-approvals'] });
    // Approving a BUDGET_REALLOCATION rewrites each allocation's plannedAmount and
    // logs a run — so the detail view, budget list, activity and run history all
    // go stale unless refreshed too. Prefix keys cover the mounted budget's id
    // (this tab doesn't receive the budget id).
    qc.invalidateQueries({ queryKey: ['growth-budget'] });
    qc.invalidateQueries({ queryKey: ['growth-budgets'] });
    qc.invalidateQueries({ queryKey: ['budget-activity'] });
    qc.invalidateQueries({ queryKey: ['autopilot-runs'] });
  };
  // Approving a budget reallocation immediately applies it: the approval IS the
  // authorization. apply() commits the plan and pushes live ONLY where an ad
  // platform is credential-write-capable — otherwise it stays a plan-only change.
  const approve = useMutation({
    mutationFn: async (r: { id: string; kind: string }) => {
      await approveRequest(r.id);
      return r.kind === 'BUDGET_REALLOCATION' ? applyReallocation(r.id) : null;
    },
    onSuccess: (applied) => {
      if (applied) {
        toast.success(
          applied.status === 'APPLIED'
            ? t('budget.appliedLive', { defaultValue: 'Approved & pushed live to the ad platform' })
            : t('budget.appliedPlan', { defaultValue: 'Approved & committed to the plan (connect an ad platform to push it live)' }),
        );
      } else {
        toast.success(t('budget.approved', 'Approved'));
      }
      setConfirmItem(null);
      invalidate();
    },
    onError: () => {
      setConfirmItem(null);
      toast.error(t('budget.decisionError', 'Could not record your decision'));
    },
  });
  const reject = useMutation({
    mutationFn: rejectRequest,
    onSuccess: () => { toast.success(t('budget.rejected', 'Rejected')); invalidate(); },
    onError: () => toast.error(t('budget.decisionError', 'Could not record your decision')),
  });

  return (
    <>
      <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {!q.data?.length ? (
          <EmptyState icon={<Check className="h-5 w-5" />} title={t('budget.noApprovals.title', 'Nothing waiting')} description={t('budget.noApprovals.desc', 'Autopilot proposals and other high-risk actions land here for your sign-off.')} />
        ) : (
          <div className="space-y-2">
            {q.data.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone="info">{t(`budget.kind.${r.kind}`, r.kind)}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                    </div>
                    <p className="mt-1 truncate text-sm">{r.summary}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => reject.mutate(r.id)} disabled={reject.isPending}>
                      <X className="mr-1 h-4 w-4" aria-hidden="true" />{t('budget.reject', 'Reject')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => (r.kind === 'BUDGET_REALLOCATION' ? setConfirmItem({ id: r.id, kind: r.kind }) : approve.mutate({ id: r.id, kind: r.kind }))}
                      disabled={approve.isPending}
                    >
                      <Check className="mr-1 h-4 w-4" aria-hidden="true" />{t('budget.approve', 'Approve')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryStateBoundary>

      <ConfirmDialog
        open={confirmItem !== null}
        onOpenChange={(o) => { if (!o) setConfirmItem(null); }}
        tone="danger"
        title={t('budget.approveConfirm.title', 'Push this reallocation live?')}
        description={t('budget.approveConfirm.desc', 'Approving commits the plan and pushes the new budget live to the ad platform where connected — real spend moves and there’s no undo.')}
        confirmLabel={t('budget.approveConfirm.confirm', 'Approve & push live')}
        cancelLabel={t('common.cancel', 'Cancel')}
        loading={approve.isPending}
        onConfirm={() => { if (confirmItem) approve.mutate(confirmItem); }}
      />
    </>
  );
}

function HistoryTab({ budgetId }: { budgetId: string }) {
  const { t } = useTranslation('marketing');
  const q = useQuery({ queryKey: ['autopilot-runs', budgetId], queryFn: () => listAutopilotRuns(budgetId) });

  return (
    <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
      {!q.data?.length ? (
        <EmptyState icon={<Play className="h-5 w-5" />} title={t('budget.noRuns.title', 'No runs yet')} description={t('budget.noRuns.desc', 'Every autopilot tick and proposal is recorded here — the full "why did the AI do this?" trail.')} />
      ) : (
        <div className="space-y-2">
          {q.data.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2">
                  <Badge tone={r.ok ? 'success' : 'danger'}>{r.autonomy}</Badge>
                  <span className="text-sm">{t(`budget.runKind.${r.kind}`, r.kind)}</span>
                </div>
                <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </QueryStateBoundary>
  );
}
