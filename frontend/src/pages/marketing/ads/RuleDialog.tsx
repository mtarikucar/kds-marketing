import { useEffect } from 'react';
import { useForm, Controller, type Resolver, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import {
  ruleSchema,
  type RuleFormValues,
  type RuleFormOutput,
  RULE_METRICS,
  RULE_OPERATORS,
  RULE_ACTIONS,
  METRIC_LABEL,
  OPERATOR_LABEL,
  ACTION_LABEL,
  BUDGET_ACTIONS,
} from './adManagementSchemas';
import type { AdAccount, AdRule } from '../../../features/marketing/api/ads.service';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Meta ad accounts the rule can target. */
  accounts: AdAccount[];
  /** When set, the dialog edits this rule; otherwise it creates. */
  rule?: AdRule | null;
  /** Pre-selected account id for new rules (the current account in the manager). */
  defaultAdAccountId?: string;
  onSubmit: (values: RuleFormOutput) => void;
  isPending: boolean;
}

function emptyDefaults(adAccountId: string): RuleFormValues {
  return {
    name: '',
    adAccountId,
    metric: 'CPL',
    operator: 'GT',
    threshold: '',
    windowDays: '7',
    action: 'DECREASE_BUDGET',
    actionValue: '',
    maxBudget: '',
    minBudget: '',
    cooldownHours: '24',
    enabled: true,
  };
}

function fromRule(rule: AdRule): RuleFormValues {
  return {
    name: rule.name,
    adAccountId: rule.adAccountId,
    metric: rule.metric,
    operator: rule.operator,
    threshold: String(rule.threshold),
    windowDays: String(rule.windowDays),
    action: rule.action,
    actionValue: rule.actionValue != null ? String(rule.actionValue) : '',
    maxBudget: rule.maxBudget != null ? String(rule.maxBudget) : '',
    minBudget: rule.minBudget != null ? String(rule.minBudget) : '',
    cooldownHours: String(rule.cooldownHours),
    enabled: rule.enabled,
  };
}

export function RuleDialog({
  open,
  onOpenChange,
  accounts,
  rule,
  defaultAdAccountId,
  onSubmit,
  isPending,
}: RuleDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!rule;

  const form = useForm<RuleFormValues, unknown, RuleFormOutput>({
    // The schema transforms string inputs (form fields) into numbers (output),
    // so the input/output types differ; cast keeps RHF's resolver generics happy.
    resolver: zodResolver(ruleSchema) as Resolver<RuleFormValues, unknown, RuleFormOutput>,
    mode: 'onBlur',
    defaultValues: emptyDefaults(defaultAdAccountId ?? accounts[0]?.id ?? ''),
  });

  useEffect(() => {
    if (!open) return;
    form.reset(rule ? fromRule(rule) : emptyDefaults(defaultAdAccountId ?? accounts[0]?.id ?? ''));
  }, [open, rule, defaultAdAccountId, accounts, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<RuleFormOutput> = (values) => onSubmit(values);

  const errors = form.formState.errors;
  const action = form.watch('action');
  const showActionValue = BUDGET_ACTIONS.has(action);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('ads.rule.editTitle', { defaultValue: 'Edit rule' })
              : t('ads.rule.newTitle', { defaultValue: 'New scaling rule' })}
          </DialogTitle>
          <DialogDescription>
            {t('ads.rule.subtitle', {
              defaultValue: 'Automatically adjust budgets or pause/resume when a metric crosses a threshold.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('ads.rule.name', { defaultValue: 'Rule name' })}
            error={fieldErr(errors.name?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('ads.rule.namePlaceholder', { defaultValue: 'e.g. Cut budget on expensive leads' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field
            label={t('ads.rule.account', { defaultValue: 'Ad account' })}
            error={fieldErr(errors.adAccountId?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="adAccountId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue
                        placeholder={t('ads.rule.accountPlaceholder', { defaultValue: 'Select an account' })}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          {/* Condition row */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('ads.rule.metric', { defaultValue: 'Metric' })} error={fieldErr(errors.metric?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="metric"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_METRICS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {t(`ads.metric.${m}`, { defaultValue: METRIC_LABEL[m] })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field label={t('ads.rule.operator', { defaultValue: 'Operator' })} error={fieldErr(errors.operator?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="operator"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_OPERATORS.map((o) => (
                          <SelectItem key={o} value={o}>
                            {t(`ads.operator.${o}`, { defaultValue: OPERATOR_LABEL[o] })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field
              label={t('ads.rule.threshold', { defaultValue: 'Threshold' })}
              error={fieldErr(errors.threshold?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="0"
                  {...form.register('threshold')}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('ads.rule.windowDays', { defaultValue: 'Window (days)' })}
            hint={t('ads.rule.windowDaysHint', { defaultValue: 'How many trailing days of metrics to evaluate.' })}
            error={fieldErr(errors.windowDays?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={90}
                step={1}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="7"
                {...form.register('windowDays')}
              />
            )}
          </Field>

          {/* Action row */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('ads.rule.action', { defaultValue: 'Action' })} error={fieldErr(errors.action?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="action"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RULE_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {t(`ads.action.${a}`, { defaultValue: ACTION_LABEL[a] })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            {showActionValue && (
              <Field
                label={t('ads.rule.actionValue', { defaultValue: 'Change (%)' })}
                hint={t('ads.rule.actionValueHint', { defaultValue: 'Percent to raise/lower the daily budget by.' })}
                error={fieldErr(errors.actionValue?.message)}
                required
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="number"
                    step="any"
                    inputMode="decimal"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    placeholder="20"
                    {...form.register('actionValue')}
                  />
                )}
              </Field>
            )}
          </div>

          {/* Budget guardrails */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('ads.rule.minBudget', { defaultValue: 'Min daily budget' })}
              hint={t('ads.rule.budgetUnitsHint', { defaultValue: 'Major currency units (optional).' })}
              error={fieldErr(errors.minBudget?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="—"
                  {...form.register('minBudget')}
                />
              )}
            </Field>
            <Field
              label={t('ads.rule.maxBudget', { defaultValue: 'Max daily budget' })}
              hint={t('ads.rule.budgetUnitsHint', { defaultValue: 'Major currency units (optional).' })}
              error={fieldErr(errors.maxBudget?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="—"
                  {...form.register('maxBudget')}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('ads.rule.cooldownHours', { defaultValue: 'Cooldown (hours)' })}
            hint={t('ads.rule.cooldownHint', { defaultValue: 'Minimum time before this rule may trigger again.' })}
            error={fieldErr(errors.cooldownHours?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                min={0}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="24"
                {...form.register('cooldownHours')}
              />
            )}
          </Field>

          <Controller
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <span className="text-sm font-medium text-foreground">
                  {t('ads.rule.enabled', { defaultValue: 'Enabled' })}
                </span>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </label>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending} disabled={accounts.length === 0}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('ads.rule.create', { defaultValue: 'Create rule' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
