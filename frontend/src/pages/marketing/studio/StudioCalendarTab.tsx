import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, X, Wallet, Sparkles, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/Dialog';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import ContentCalendarPage from '../contentCalendar/ContentCalendarPage';
import { generateWeeklyPlan, decidePlanItem, type WeeklyPlan, type WeeklyPlanItem } from '../../../features/marketing/api/weeklyPlan.service';

const money = (n: number | null | undefined) => {
  if (n == null) return '—';
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n)} TRY`;
  }
};

const TYPE_TONE: Record<string, 'info' | 'primary' | 'success' | 'warning'> = {
  SOCIAL_POST: 'info', TREND_REMIX: 'success', CAMPAIGN: 'primary', CONTENT_IDEA: 'warning',
};

/**
 * The Growth Studio's calendar tab: the full month calendar plus the flagship
 * "Generate weekly plan" flow — one click drafts a whole week of content and a
 * budget analysis, which the user reviews and approves item by item.
 */
export default function StudioCalendarTab() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [plan, setPlan] = useState<WeeklyPlan | null>(null);
  const [open, setOpen] = useState(false);

  const generate = useMutation({
    mutationFn: () => generateWeeklyPlan(),
    onMutate: () => setOpen(true),
    onSuccess: (p) => {
      setPlan(p);
      qc.invalidateQueries({ queryKey: ['content-calendar'] });
    },
    onError: () => {
      setOpen(false);
      toast.error(t('weekly.error', 'Could not generate a plan'));
    },
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'discard' }) => decidePlanItem(id, decision),
    onSuccess: (_r, { id, decision }) => {
      setPlan((prev) => prev && { ...prev, items: prev.items.map((it) => (it.id === id ? { ...it, status: decision === 'approve' ? 'APPROVED' : 'DISCARDED' } : it)) });
    },
    onError: () => toast.error(t('weekly.decideError', 'Could not update the item')),
  });

  return (
    <>
      <ContentCalendarPage embedded onGenerateWeeklyPlan={() => generate.mutate()} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('weekly.title', 'Weekly plan')}</DialogTitle>
            <DialogDescription>{t('weekly.desc', 'A full week of drafts + a budget analysis. Approve what you like — nothing publishes until you do.')}</DialogDescription>
          </DialogHeader>

          {generate.isPending || !plan ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner /> {t('weekly.generating', 'Planning your week…')}
            </div>
          ) : (
            <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
              {plan.budgetBreakdown && <BudgetCard b={plan.budgetBreakdown} />}
              <div className="space-y-2">
                {plan.items.map((it) => (
                  <PlanItemRow key={it.id} item={it} onDecide={(decision) => decide.mutate({ id: it.id, decision })} busy={decide.isPending} />
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function BudgetCard({ b }: { b: NonNullable<WeeklyPlan['budgetBreakdown']> }) {
  const { t } = useTranslation('marketing');
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('weekly.budget.title', 'Budget analysis (this week)')}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('weekly.budget.weekly', 'Weekly budget')} value={money(b.weeklyBudget)} />
          <Stat label={t('weekly.budget.ads', 'Ad boost')} value={money(b.adSpend)} />
          <Stat label={t('weekly.budget.content', 'Content')} value={money(b.contentGen)} />
          <Stat label={t('weekly.budget.convos', 'Conversations')} value={money(b.conversations)} />
        </div>
        {b.overBudget ? (
          <Callout tone="warning" title={t('weekly.budget.over', 'Over budget')} icon={<ShieldAlert className="h-4 w-4" />}>
            {t('weekly.budget.overDesc', 'This plan ({{total}}) exceeds the weekly budget. Discard a few items or raise the budget.').replace('{{total}}', money(b.total))}
          </Callout>
        ) : (
          <p className="text-xs text-muted-foreground">{t('weekly.budget.within', 'Plan total {{total}} — within budget.').replace('{{total}}', money(b.total))}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-micro uppercase text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function PlanItemRow({ item, onDecide, busy }: { item: WeeklyPlanItem; onDecide: (d: 'approve' | 'discard') => void; busy: boolean }) {
  const { t } = useTranslation('marketing');
  const day = new Date(`${item.day.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  const decided = item.status === 'APPROVED' || item.status === 'DISCARDED';
  return (
    <div className={`rounded-md border border-border p-3 ${item.status === 'DISCARDED' ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">{day}</span>
            <Badge tone={TYPE_TONE[item.type] ?? 'neutral'}>{t(`weekly.type.${item.type}`, item.type)}</Badge>
            {item.channel && <span className="text-xs text-muted-foreground">{item.channel}</span>}
          </div>
          <p className="mt-1 text-sm font-medium">{item.title}</p>
          {item.draft && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.draft}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {decided ? (
            <Badge tone={item.status === 'APPROVED' ? 'success' : 'neutral'}>{t(`weekly.status.${item.status}`, item.status)}</Badge>
          ) : (
            <>
              <Button variant="ghost" size="sm" aria-label={t('weekly.discard', 'Discard')} disabled={busy} onClick={() => onDecide('discard')}><X className="h-4 w-4" /></Button>
              <Button size="sm" disabled={busy} onClick={() => onDecide('approve')}><Check className="mr-1 h-4 w-4" />{t('weekly.approve', 'Approve')}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
