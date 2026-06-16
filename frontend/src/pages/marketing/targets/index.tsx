/**
 * TargetsPage — Console migration (Team & Targets, Phase 4 Task 2).
 *
 * Preserved verbatim:
 *   - useQuery(['marketing','users']) with staleTime
 *   - useQuery(['marketing','targets',{period,repFilter}]) + endpoint /targets
 *   - setTarget mutation (POST /targets) + invalidates ['marketing','targets'] + ['marketing','performance']
 *   - delTarget mutation (DELETE /targets/:id) + same invalidations
 *   - filter state (period / repFilter)
 *   - validation logic (rep required, period format, targetValue >= 0)
 *   - TARGET_METRICS, TARGET_METRIC_LABELS constants
 *   - COMMISSION_AMOUNT currency formatting
 *
 * Presentation upgrade:
 *   - PageHeader
 *   - Card + RHF+Zod form for "Set a target"
 *   - Card + FilterBar-style filter row
 *   - Table primitives + metric Badge + ConfirmDialog for delete
 *   - Tokens everywhere, dark-mode-safe, lucide icons
 */
import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Target, Trash2 } from 'lucide-react';
import marketingApi from '@/features/marketing/api/marketingApi';
import { TARGET_METRICS, TARGET_METRIC_LABELS } from '@/features/marketing/types';
import type { SalesTarget, MarketingUserInfo } from '@/features/marketing/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';

// ── Types ──────────────────────────────────────────────────────────────────
interface RepRow extends MarketingUserInfo {
  role: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────
const currentPeriod = () => new Date().toISOString().slice(0, 7);
const metricLabel = (m: string) =>
  TARGET_METRIC_LABELS[m as keyof typeof TARGET_METRIC_LABELS] || m;

// ── Schema ─────────────────────────────────────────────────────────────────
const targetSchema = z.object({
  marketingUserId: z.string().min(1, 'Select a rep'),
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Pick a valid period (YYYY-MM)'),
  metric: z.enum(['WON_LEADS', 'COMMISSION_AMOUNT', 'CONNECTED_CALLS']),
  targetValue: z
    .string()
    .min(1, 'Enter a target value')
    .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number'),
  notes: z.string().optional(),
});

type TargetFormValues = z.infer<typeof targetSchema>;

// ── Component ──────────────────────────────────────────────────────────────
export default function TargetsPage() {
  const queryClient = useQueryClient();

  // Filter state
  const [period, setPeriod] = useState(currentPeriod());
  const [repFilter, setRepFilter] = useState('');

  // Confirm delete state
  const [deleteTarget, setDeleteTarget] = useState<SalesTarget | null>(null);

  // ── Form (RHF+Zod) ───────────────────────────────────────────────────────
  const {
    register,
    handleSubmit,
    control,
    reset: resetForm,
    formState: { errors },
  } = useForm<TargetFormValues>({
    resolver: zodResolver(targetSchema),
    defaultValues: {
      marketingUserId: '',
      period: currentPeriod(),
      metric: 'WON_LEADS',
      targetValue: '',
      notes: '',
    },
  });

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    staleTime: 60_000,
  });
  const repOptions = reps.filter((r) => r.role === 'REP');
  const repName = (id: string) => {
    const r = reps.find((x) => x.id === id);
    return r ? `${r.firstName} ${r.lastName}` : id;
  };

  const { data: targets = [], isLoading } = useQuery<SalesTarget[]>({
    queryKey: ['marketing', 'targets', { period, repFilter }],
    queryFn: () =>
      marketingApi
        .get('/targets', {
          params: {
            period: period || undefined,
            marketingUserId: repFilter || undefined,
          },
        })
        .then((r) => r.data),
  });

  // ── Invalidations ─────────────────────────────────────────────────────────
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'targets'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'performance'] });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const setTargetMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/targets', payload),
    onSuccess: () => {
      toast.success('Target saved');
      invalidate();
      resetForm((prev) => ({ ...prev, targetValue: '', notes: '' }));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'Failed to save target'),
  });

  const delTargetMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/targets/${id}`),
    onSuccess: () => {
      toast.success('Target removed');
      invalidate();
      setDeleteTarget(null);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'Failed to remove target'),
  });

  // ── Submit ────────────────────────────────────────────────────────────────
  function onSubmit(values: TargetFormValues) {
    setTargetMutation.mutate({
      marketingUserId: values.marketingUserId,
      period: values.period,
      metric: values.metric,
      targetValue: Number(values.targetValue),
      notes: values.notes || undefined,
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales Targets"
        description="Set monthly targets per rep and track attainment."
      />

      {/* Set a target — RHF+Zod form */}
      <Card>
        <CardHeader>
          <CardTitle>Set a target</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {/* Rep */}
              <Field
                error={errors.marketingUserId?.message}
                className="lg:col-span-1"
              >
                {({ id }) => (
                  <Controller
                    name="marketingUserId"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger
                          id={id}
                          aria-invalid={!!errors.marketingUserId}
                        >
                          <SelectValue placeholder="Rep…" />
                        </SelectTrigger>
                        <SelectContent>
                          {repOptions.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.firstName} {r.lastName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>

              {/* Period */}
              <Field error={errors.period?.message} className="lg:col-span-1">
                {({ id, invalid }) => (
                  <Input
                    id={id}
                    type="month"
                    aria-invalid={invalid}
                    {...register('period')}
                  />
                )}
              </Field>

              {/* Metric */}
              <Field error={errors.metric?.message} className="lg:col-span-1">
                {({ id }) => (
                  <Controller
                    name="metric"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TARGET_METRICS.map((m) => (
                            <SelectItem key={m} value={m}>
                              {metricLabel(m)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>

              {/* Target value */}
              <Field
                error={errors.targetValue?.message}
                className="lg:col-span-1"
              >
                {({ id, invalid }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Target value"
                    aria-invalid={invalid}
                    {...register('targetValue')}
                  />
                )}
              </Field>

              <Button
                type="submit"
                loading={setTargetMutation.isPending}
                className="lg:col-span-1 self-end"
              >
                Set target
              </Button>
            </div>

            {/* Notes — full width */}
            <Field error={errors.notes?.message}>
              {({ id }) => (
                <Input
                  id={id}
                  placeholder="Notes (optional)"
                  {...register('notes')}
                />
              )}
            </Field>
          </form>
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-auto"
            />
            <Select value={repFilter || '__all__'} onValueChange={(v) => setRepFilter(v === '__all__' ? '' : v)}>
              <SelectTrigger className="w-auto min-w-[160px]">
                <SelectValue placeholder="All reps" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All reps</SelectItem>
                {repOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.firstName} {r.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(period || repFilter) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setPeriod(''); setRepFilter(''); }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Targets table */}
      <Card>
        {isLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : targets.length === 0 ? (
          <EmptyState
            icon={<Target className="h-8 w-8" />}
            title="No targets set"
            description="Use the form above to set a monthly target."
            className="border-0"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Rep</TH>
                  <TH>Period</TH>
                  <TH>Metric</TH>
                  <TH numeric>Target</TH>
                  <TH className="hidden md:table-cell">Notes</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {targets.map((t) => (
                  <TR key={t.id}>
                    <TD className="font-medium text-foreground">
                      {t.marketingUser
                        ? `${t.marketingUser.firstName} ${t.marketingUser.lastName}`
                        : repName(t.marketingUserId)}
                    </TD>
                    <TD className="text-muted-foreground">{t.period}</TD>
                    <TD>
                      <Badge tone="primary" size="sm">
                        {metricLabel(t.metric)}
                      </Badge>
                    </TD>
                    <TD numeric className="font-medium">
                      {t.metric === 'COMMISSION_AMOUNT'
                        ? `$${Number(t.targetValue).toFixed(2)}`
                        : Number(t.targetValue)}
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground text-xs">
                      {t.notes || '—'}
                    </TD>
                    <TD>
                      <button
                        onClick={() => setDeleteTarget(t)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-danger-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Delete target"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Confirm delete */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Remove target?"
        description={
          deleteTarget
            ? `Remove the ${metricLabel(deleteTarget.metric)} target for ${
                deleteTarget.marketingUser
                  ? `${deleteTarget.marketingUser.firstName} ${deleteTarget.marketingUser.lastName}`
                  : repName(deleteTarget.marketingUserId)
              } (${deleteTarget.period})?`
            : undefined
        }
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => deleteTarget && delTargetMutation.mutate(deleteTarget.id)}
        loading={delTargetMutation.isPending}
      />
    </div>
  );
}
