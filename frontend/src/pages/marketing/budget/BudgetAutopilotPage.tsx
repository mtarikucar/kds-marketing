import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Wallet, Gauge, PiggyBank, ShieldAlert, Sparkles, Check, X, Play } from 'lucide-react';
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
import { fmtDateTime } from '../../../features/marketing/utils/format';
import {
  listGrowthBudgets,
  getGrowthBudget,
  setBudgetKillSwitch,
  proposeBudget,
  listAutopilotRuns,
  listPendingApprovals,
  approveRequest,
  rejectRequest,
  type GrowthBudget,
  type ProposeResult,
} from '../../../features/marketing/api/growthBudget.service';
import { BudgetDialog } from './BudgetDialog';

const num = (s: string | number | null | undefined) => (s == null ? 0 : typeof s === 'number' ? s : parseFloat(s) || 0);

function money(v: string | number | null | undefined, currency = 'TRY'): string {
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(num(v));
  } catch {
    return `${num(v).toFixed(0)} ${currency}`;
  }
}

/**
 * Budget Autopilot console (Faz 7). The workspace sets ONE growth budget; the
 * autopilot paces it, proposes cross-channel reallocations (shadow — no money
 * moves without approval), and every conversation/content spend settles into it.
 * OWNER/MANAGER only (the route + backend both gate it).
 */
export default function BudgetAutopilotPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const budgetsQ = useQuery({ queryKey: ['growth-budgets'], queryFn: listGrowthBudgets });
  const budgets = budgetsQ.data ?? [];
  const current = budgets[0]; // most recent period first (backend orders desc)

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('budget.title', 'Budget Autopilot')}
        description={t('budget.subtitle', 'Set one growth budget — Jeeta paces it, proposes reallocations, and settles every spend into it.')}
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            {current ? t('budget.edit', 'Edit budget') : t('budget.create', 'Create budget')}
          </Button>
        }
      />

      <QueryStateBoundary isLoading={budgetsQ.isLoading} isError={budgetsQ.isError} onRetry={() => budgetsQ.refetch()}>
        {!current ? (
          <EmptyState
            icon={<Wallet className="h-6 w-6" />}
            title={t('budget.empty.title', 'No growth budget yet')}
            description={t('budget.empty.desc', 'Give the autopilot a monthly budget and it will pace spend, propose cross-channel reallocations, and price every conversation into it — nothing moves without your approval.')}
            action={<Button onClick={() => setDialogOpen(true)}>{t('budget.create', 'Create budget')}</Button>}
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
          qc.invalidateQueries({ queryKey: ['growth-budgets'] });
        }}
      />
    </div>
  );
}

function BudgetDetail({ budget: summary }: { budget: GrowthBudget }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const detailQ = useQuery({ queryKey: ['growth-budget', summary.id], queryFn: () => getGrowthBudget(summary.id) });
  const budget = detailQ.data ?? summary;
  const allocations = budget.allocations ?? [];
  const currency = budget.currency;

  const planned = useMemo(() => allocations.reduce((s, a) => s + num(a.plannedAmount), 0), [allocations]);
  const spent = useMemo(() => allocations.reduce((s, a) => s + num(a.spentAmount), 0), [allocations]);
  const total = num(budget.totalAmount);
  const spentPct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 0;

  const kill = useMutation({
    mutationFn: (on: boolean) => setBudgetKillSwitch(budget.id, on),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['growth-budget', budget.id] });
      qc.invalidateQueries({ queryKey: ['growth-budgets'] });
    },
    onError: () => toast.error(t('budget.killError', 'Could not update the kill-switch')),
  });

  const statusTone: Record<string, 'success' | 'warning' | 'danger'> = { ACTIVE: 'success', PAUSED: 'warning', KILLED: 'danger' };

  return (
    <div className="space-y-6">
      {budget.killSwitch && (
        <Callout tone="danger" title={t('budget.killedTitle', 'Kill-switch is ON')} icon={<ShieldAlert className="h-4 w-4" />}>
          {t('budget.killedDesc', 'All autonomous activity is halted. No proposals or spend until you turn it off.')}
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t('budget.stat.total', 'Monthly budget')} value={money(total, currency)} icon={<Wallet className="h-4 w-4" />} />
        <StatCard label={t('budget.stat.spent', 'Spent so far')} value={money(spent, currency)} icon={<Gauge className="h-4 w-4" />} delta={{ direction: spentPct > 90 ? 'up' : 'flat', value: `${spentPct}%` }} />
        <StatCard label={t('budget.stat.reserve', 'Exploration reserve')} value={`${budget.explorationPct}%`} icon={<PiggyBank className="h-4 w-4" />} />
        <StatCard label={t('budget.stat.scope', 'Scope')} value={budget.scope === 'AD_ONLY' ? t('budget.scope.adOnly', 'Ads only') : t('budget.scope.holistic', 'Holistic')} />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{budget.periodKey}</span>
            <Badge tone={statusTone[budget.status] ?? 'neutral'}>{t(`budget.status.${budget.status}`, budget.status)}</Badge>
            {budget.targetRoas && <Badge tone="neutral">{t('budget.targetRoas', 'Target ROAS')} {num(budget.targetRoas)}x</Badge>}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <ShieldAlert className={`h-4 w-4 ${budget.killSwitch ? 'text-danger' : 'text-muted-foreground'}`} />
            {t('budget.killSwitch', 'Kill-switch')}
            <Switch checked={budget.killSwitch} disabled={kill.isPending} onCheckedChange={(v) => kill.mutate(v)} aria-label={t('budget.killSwitch', 'Kill-switch')} />
          </label>
        </CardContent>
      </Card>

      <Tabs defaultValue="allocation">
        <TabsList>
          <TabsTrigger value="allocation">{t('budget.tab.allocation', 'Allocation')}</TabsTrigger>
          <TabsTrigger value="approvals">{t('budget.tab.approvals', 'Approvals')}</TabsTrigger>
          <TabsTrigger value="history">{t('budget.tab.history', 'History')}</TabsTrigger>
        </TabsList>

        <TabsContent value="allocation" className="pt-4">
          <AllocationTab budget={budget} allocations={allocations} planned={planned} />
        </TabsContent>
        <TabsContent value="approvals" className="pt-4">
          <ApprovalsTab />
        </TabsContent>
        <TabsContent value="history" className="pt-4">
          <HistoryTab budgetId={budget.id} />
        </TabsContent>
      </Tabs>
    </div>
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
        <Button variant="secondary" onClick={() => propose.mutate()} disabled={propose.isPending || budget.killSwitch}>
          <Sparkles className="mr-1.5 h-4 w-4" />
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
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('budget.col.channel', 'Channel')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('budget.col.planned', 'Planned')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('budget.col.spent', 'Spent')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('budget.col.mroas', 'Marginal ROAS')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {allocations.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2.5 font-medium">{CHANNEL_LABEL[a.channel] ?? a.channel}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(a.plannedAmount, currency)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{money(a.spentAmount, currency)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{a.marginalRoas ? `${num(a.marginalRoas).toFixed(2)}x` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proposal?.plan && !proposal.plan.noop && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('budget.proposal.title', 'Shadow proposal')}</CardTitle>
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pending-approvals'] });
  const approve = useMutation({
    mutationFn: approveRequest,
    onSuccess: () => { toast.success(t('budget.approved', 'Approved')); invalidate(); },
    onError: () => toast.error(t('budget.decisionError', 'Could not record your decision')),
  });
  const reject = useMutation({
    mutationFn: rejectRequest,
    onSuccess: () => { toast.success(t('budget.rejected', 'Rejected')); invalidate(); },
    onError: () => toast.error(t('budget.decisionError', 'Could not record your decision')),
  });

  return (
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
                    <X className="mr-1 h-4 w-4" />{t('budget.reject', 'Reject')}
                  </Button>
                  <Button size="sm" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
                    <Check className="mr-1 h-4 w-4" />{t('budget.approve', 'Approve')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </QueryStateBoundary>
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
