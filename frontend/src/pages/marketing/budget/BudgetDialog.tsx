import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Slider } from '@/components/ui/Slider';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { upsertGrowthBudget, type GrowthBudget, type BudgetScope, type AllocatorStage } from '../../../features/marketing/api/growthBudget.service';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: GrowthBudget;
  onSaved: () => void;
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

export function BudgetDialog({ open, onOpenChange, budget, onSaved }: Props) {
  const { t } = useTranslation('marketing');
  const [total, setTotal] = useState('');
  const [scope, setScope] = useState<BudgetScope>('HOLISTIC');
  const [exploration, setExploration] = useState(20);
  const [stage, setStage] = useState<AllocatorStage>('MARGINAL');
  const [targetRoas, setTargetRoas] = useState('');

  // Re-seed the form whenever the dialog opens (edit = prefill, create = blank).
  useEffect(() => {
    if (!open) return;
    setTotal(budget ? String(parseFloat(budget.totalAmount) || '') : '');
    setScope(budget?.scope ?? 'HOLISTIC');
    setExploration(budget?.explorationPct ?? 20);
    setStage(budget?.allocatorStage ?? 'MARGINAL');
    setTargetRoas(budget?.targetRoas ? String(parseFloat(budget.targetRoas)) : '');
  }, [open, budget]);

  const save = useMutation({
    mutationFn: () =>
      upsertGrowthBudget({
        periodKey: budget?.periodKey ?? currentMonth(),
        totalAmount: Number(total),
        scope,
        explorationPct: exploration,
        allocatorStage: stage,
        ...(targetRoas ? { targetRoas: Number(targetRoas) } : {}),
      }),
    onSuccess: () => {
      toast.success(t('budget.saved', 'Budget saved'));
      onSaved();
    },
    onError: () => toast.error(t('budget.saveError', 'Could not save the budget')),
  });

  const totalValid = Number(total) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{budget ? t('budget.edit', 'Edit budget') : t('budget.create', 'Create budget')}</DialogTitle>
          <DialogDescription>
            {t('budget.dialog.desc', 'One monthly growth budget. This is a hard cap the autopilot can never exceed.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="budget-total">{t('budget.field.total', 'Monthly budget (TRY)')}</Label>
            <Input id="budget-total" type="number" inputMode="decimal" min={0} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="30000" />
          </div>

          <div className="space-y-1.5">
            <Label>{t('budget.field.scope', 'Scope')}</Label>
            <SegmentedControl
              aria-label={t('budget.field.scope', 'Scope')}
              value={scope}
              onChange={(v) => setScope(v as BudgetScope)}
              options={[
                { value: 'HOLISTIC', label: t('budget.scope.holistic', 'Holistic') },
                { value: 'AD_ONLY', label: t('budget.scope.adOnly', 'Ads only') },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {scope === 'HOLISTIC'
                ? t('budget.scope.holisticHint', 'Ads + content + conversations all draw from this budget.')
                : t('budget.scope.adOnlyHint', 'Only paid ad spend is managed; content & conversations are excluded.')}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="budget-exploration">{t('budget.field.exploration', 'Exploration reserve')}</Label>
              <span className="text-sm tabular-nums text-muted-foreground">{exploration}%</span>
            </div>
            <Slider id="budget-exploration" min={0} max={50} step={5} value={[exploration]} onValueChange={([v]) => setExploration(v)} />
            <p className="text-xs text-muted-foreground">{t('budget.field.explorationHint', 'Share held back for learning, never spent on proven channels.')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t('budget.field.stage', { defaultValue: 'Allocation strategy' })}</Label>
            <SegmentedControl
              aria-label={t('budget.field.stage', { defaultValue: 'Allocation strategy' })}
              value={stage}
              onChange={(v) => setStage(v as AllocatorStage)}
              options={[
                { value: 'MARGINAL', label: t('budget.stage.marginal', { defaultValue: 'Marginal ROAS' }) },
                { value: 'BANDIT', label: t('budget.stage.bandit', { defaultValue: 'Bandit' }) },
                { value: 'MMM', label: t('budget.stage.mmm', { defaultValue: 'MMM-lite' }) },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {stage === 'MARGINAL'
                ? t('budget.stage.marginalHint', { defaultValue: 'Shifts budget toward the strongest next dollar. The best default.' })
                : stage === 'BANDIT'
                  ? t('budget.stage.banditHint', { defaultValue: 'Explores under uncertainty — funds channels that might be better, not just proven ones.' })
                  : t('budget.stage.mmmHint', { defaultValue: 'Fits diminishing-returns curves per channel and equalizes marginal return.' })}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="budget-roas">{t('budget.field.targetRoas', 'Target ROAS (optional)')}</Label>
            <Input id="budget-roas" type="number" inputMode="decimal" min={0} step={0.1} value={targetRoas} onChange={(e) => setTargetRoas(e.target.value)} placeholder="2.5" />
            <p className="text-xs text-muted-foreground">{t('budget.field.targetRoasHint', 'Channels below this return-on-ad-spend floor are not funded from the proven pool.')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={!totalValid || save.isPending}>
            {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
