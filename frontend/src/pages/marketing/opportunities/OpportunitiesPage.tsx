import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Settings, Trophy, XCircle, Trash2, GripVertical, TrendingUp, ChevronDown } from 'lucide-react';

import {
  getBoard,
  getForecast,
  listPipelines,
  createOpportunity,
  updateOpportunity,
  moveOpportunity,
  winOpportunity,
  loseOpportunity,
  deleteOpportunity,
  type Board,
  type Forecast,
  type Opportunity,
} from '../../../features/marketing/api/opportunities.service';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import {
  PageHeader,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Input,
  Textarea,
  Badge,
  Spinner,
} from '@/components/ui';

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

function money(value: string | number, currency: string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(Number.isFinite(n) ? n : 0);
  } catch {
    return `${n} ${currency}`;
  }
}

interface OppFormState {
  id?: string;
  name: string;
  value: string;
  currency: string;
  stageId?: string;
  notes: string;
  expectedCloseDate: string; // 'YYYY-MM-DD' or ''
}

const EMPTY_FORM: OppFormState = { name: '', value: '', currency: 'TRY', notes: '', expectedCloseDate: '' };

/** Small label+control wrapper for the deal dialog. */
function Labeled({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={['space-y-1.5', className].filter(Boolean).join(' ')}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

/**
 * Opportunities kanban board (GoHighLevel parity). A pipeline selector across
 * the top, one column per stage, draggable deal cards. Dropping a card on
 * another column moves it (and resolves it WON/LOST when dropped on a terminal
 * stage). Managers can jump to pipeline settings; reps see only their own deals
 * (the backend scopes the board).
 */
export default function OpportunitiesPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [pipelineId, setPipelineId] = useState<string | undefined>(undefined);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<OppFormState>(EMPTY_FORM);

  const { data: pipelines } = useQuery({
    queryKey: ['marketing', 'pipelines'],
    queryFn: listPipelines,
    staleTime: 60_000,
  });

  const activePipelineId = pipelineId ?? pipelines?.find((p) => p.isDefault)?.id ?? pipelines?.[0]?.id;

  const {
    data: board,
    isLoading,
    isError,
    refetch,
  } = useQuery<Board>({
    queryKey: ['marketing', 'opportunities', 'board', activePipelineId],
    queryFn: () => getBoard(activePipelineId),
    enabled: !!pipelines, // wait until pipelines resolve so the default is known
  });

  const invalidateBoard = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'opportunities'] });
  };

  const moveMutation = useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) => moveOpportunity(id, stageId),
    onSuccess: invalidateBoard,
    onError: () => toast.error(t('opportunities.moveError', 'Could not move the deal')),
  });

  const saveMutation = useMutation({
    mutationFn: (f: OppFormState) =>
      f.id
        ? updateOpportunity(f.id, {
            name: f.name,
            value: f.value === '' ? undefined : Number(f.value),
            currency: f.currency,
            notes: f.notes || undefined,
            expectedCloseDate: f.expectedCloseDate === '' ? null : f.expectedCloseDate,
          })
        : createOpportunity({
            name: f.name,
            pipelineId: activePipelineId,
            stageId: f.stageId,
            value: f.value === '' ? undefined : Number(f.value),
            currency: f.currency,
            notes: f.notes || undefined,
            expectedCloseDate: f.expectedCloseDate || undefined,
          }),
    onSuccess: () => {
      invalidateBoard();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('opportunities.saved', 'Saved'));
    },
    onError: () => toast.error(t('opportunities.saveError', 'Could not save the deal')),
  });

  const winMutation = useMutation({
    mutationFn: (id: string) => winOpportunity(id),
    onSuccess: () => {
      invalidateBoard();
      toast.success(t('opportunities.markedWon', 'Marked as won'));
    },
    onError: () => toast.error(t('opportunities.winError', 'Could not mark the deal as won')),
  });
  const loseMutation = useMutation({
    mutationFn: (id: string) => loseOpportunity(id),
    onSuccess: () => {
      invalidateBoard();
      toast.success(t('opportunities.markedLost', 'Marked as lost'));
    },
    onError: () => toast.error(t('opportunities.loseError', 'Could not mark the deal as lost')),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteOpportunity(id),
    onSuccess: () => {
      invalidateBoard();
      setDialogOpen(false);
      toast.success(t('opportunities.deleted', 'Deal deleted'));
    },
    onError: () => toast.error(t('opportunities.deleteError', 'Could not delete the deal')),
  });

  const boardTotal = useMemo(
    () => (board?.stages ?? []).reduce((sum, s) => sum + s.totalValue, 0),
    [board],
  );
  // Only render a currency symbol on aggregate totals when the WHOLE board is a
  // single currency — summing across currencies under one symbol implies a false
  // conversion (€2,000 + $1,000 ≠ "$3,000"). Mirrors the forecast's guard; the
  // individual deal cards still show each deal's own currency.
  const boardCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const s of board?.stages ?? []) for (const o of s.opportunities) if (o.currency) set.add(o.currency);
    return set;
  }, [board]);
  const fmtBoard = (n: number) =>
    boardCurrencies.size === 1 ? money(n, [...boardCurrencies][0]) : n.toLocaleString();

  const [showForecast, setShowForecast] = useState(false);
  const { data: forecast } = useQuery<Forecast>({
    queryKey: ['marketing', 'opportunities', 'forecast', activePipelineId],
    queryFn: () => getForecast(activePipelineId),
    enabled: showForecast && !!activePipelineId,
  });
  // Single-currency tenants (the common case) get a real currency symbol; a
  // mixed-currency pipeline falls back to a plain number to avoid implying a
  // false conversion.
  const forecastCurrency = forecast && forecast.currencies.length === 1 ? forecast.currencies[0] : '';
  const fmtForecast = (n: number) => (forecastCurrency ? money(n, forecastCurrency) : n.toLocaleString());

  const openNew = (stageId?: string) => {
    setForm({ ...EMPTY_FORM, stageId });
    setDialogOpen(true);
  };
  const openEdit = (o: Opportunity) => {
    setForm({
      id: o.id,
      name: o.name,
      value: String(o.value ?? ''),
      currency: o.currency,
      stageId: o.stageId,
      notes: o.notes ?? '',
      expectedCloseDate: o.expectedCloseDate ? o.expectedCloseDate.slice(0, 10) : '',
    });
    setDialogOpen(true);
  };

  const onDrop = (stageId: string) => {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const from = board?.stages.find((s) => s.opportunities.some((o) => o.id === id));
    if (from?.id === stageId) return; // same column — no-op
    moveMutation.mutate({ id, stageId });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('opportunities.title', 'Opportunities')}
        description={t('opportunities.subtitle', 'Track deals across your sales pipelines.')}
        actions={
          <div className="flex items-center gap-2">
            {isManager && (
              <Button asChild variant="outline" size="md">
                <Link to="/settings/pipelines">
                  <Settings className="w-4 h-4" aria-hidden="true" />
                  {t('opportunities.managePipelines', 'Pipelines')}
                </Link>
              </Button>
            )}
            <Button size="md" onClick={() => openNew()}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              {t('opportunities.newDeal', 'New deal')}
            </Button>
          </div>
        }
      />

      {/* Pipeline selector + total */}
      <div className="flex items-center justify-between gap-3">
        <Select
          value={activePipelineId ?? ''}
          onValueChange={(v) => setPipelineId(v)}
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder={t('opportunities.selectPipeline', 'Select pipeline')} />
          </SelectTrigger>
          <SelectContent>
            {(pipelines ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                {p.isDefault ? ' ★' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-3">
          {board && (
            <p className="text-sm text-muted-foreground">
              {t('opportunities.openTotal', 'Open total')}: {fmtBoard(boardTotal)}
            </p>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowForecast((v) => !v)}>
            <TrendingUp className="w-4 h-4" aria-hidden="true" />
            {t('opportunities.forecast', 'Forecast')}
            <ChevronDown className={`w-4 h-4 transition-transform ${showForecast ? 'rotate-180' : ''}`} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Weighted forecast */}
      {showForecast && forecast && (
        <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <div className="text-caption text-muted-foreground">{t('opportunities.weightedTotal', 'Weighted (expected)')}</div>
              <div className="text-xl font-semibold text-foreground">{fmtForecast(forecast.weightedTotal)}</div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">{t('opportunities.openTotal', 'Open total')}</div>
              <div className="text-lg text-muted-foreground">{fmtForecast(forecast.rawTotal)}</div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">{t('opportunities.openDeals', 'Open deals')}</div>
              <div className="text-lg text-muted-foreground">{forecast.openCount}</div>
            </div>
            {forecast.currencies.length > 1 && (
              <Badge tone="warning" size="sm">{t('opportunities.mixedCurrency', 'Mixed currencies')}: {forecast.currencies.join(', ')}</Badge>
            )}
          </div>

          {/* Per-stage weighted bars */}
          <div className="space-y-1.5">
            {forecast.stages.map((s) => {
              const pct = forecast.rawTotal > 0 ? Math.round((s.weightedValue / forecast.weightedTotal || 0) * 100) : 0;
              return (
                <div key={s.stageId} className="flex items-center gap-3 text-sm">
                  <div className="w-40 shrink-0 truncate">
                    {s.name} <span className="text-muted-foreground">· {s.probability}%</span>
                  </div>
                  <div className="flex-1 h-2 rounded-full bg-surface-muted overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                  <div className="w-40 shrink-0 text-right tabular-nums">
                    {fmtForecast(s.weightedValue)}
                    <span className="text-muted-foreground"> / {fmtForecast(s.rawValue)} · {s.count}</span>
                  </div>
                </div>
              );
            })}
            {forecast.stages.length === 0 && (
              <p className="text-caption text-muted-foreground">{t('opportunities.noOpenDeals', 'No open deals to forecast.')}</p>
            )}
          </div>

          {/* Month buckets by expected close date */}
          {forecast.months.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
              {forecast.months.map((m) => (
                <div key={m.month} className="rounded border border-border px-2 py-1 text-caption">
                  <span className="font-medium">{m.month === 'unscheduled' ? t('opportunities.unscheduled', 'Unscheduled') : m.month}</span>
                  <span className="text-muted-foreground"> · {fmtForecast(m.rawValue)} · {m.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isError && (
        <div className="flex flex-col items-center gap-3 py-10">
          <p className="text-sm text-danger">
            {t('opportunities.loadFailed', 'Could not load the board.')}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {/* Kanban columns */}
      {board && !isError && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {board.stages.map((stage) => (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage.id);
              }}
              onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
              onDrop={() => onDrop(stage.id)}
              className={[
                'flex-shrink-0 w-72 rounded-lg border bg-surface-muted/40 p-2 transition-colors',
                overStage === stage.id ? 'border-primary bg-primary/5' : 'border-border',
              ].join(' ')}
            >
              <div className="flex items-center justify-between px-1 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-sm text-foreground">{stage.name}</span>
                  <Badge tone={stage.isWon ? 'success' : stage.isLost ? 'danger' : 'neutral'} size="sm">
                    {stage.count}
                  </Badge>
                </div>
                <span className="text-micro text-muted-foreground">
                  {fmtBoard(stage.totalValue)}
                </span>
              </div>

              <div className="space-y-2 min-h-[40px]">
                {stage.opportunities.map((o) => (
                  <div
                    key={o.id}
                    draggable
                    onDragStart={() => setDragId(o.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => openEdit(o)}
                    className={[
                      'group rounded-md border border-border bg-surface p-2.5 shadow-sm cursor-pointer hover:border-primary/50',
                      dragId === o.id ? 'opacity-50' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical
                        className="w-3.5 h-3.5 mt-0.5 text-muted-foreground opacity-0 group-hover:opacity-100"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{o.name}</p>
                        <p className="text-caption text-muted-foreground mt-0.5">
                          {money(o.value, o.currency)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => openNew(stage.id)}
                className="mt-2 w-full flex items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted-foreground hover:text-primary hover:bg-surface"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                {t('opportunities.add', 'Add')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.id
                ? t('opportunities.editDeal', 'Edit deal')
                : t('opportunities.newDeal', 'New deal')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Labeled label={t('opportunities.name', 'Name')}>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('opportunities.namePlaceholder', 'Acme Corp — annual plan')}
              />
            </Labeled>
            <div className="flex gap-2">
              <Labeled label={t('opportunities.value', 'Value')} className="flex-1">
                <Input
                  type="number"
                  min={0}
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                />
              </Labeled>
              <Labeled label={t('opportunities.currency', 'Currency')} className="w-32">
                <Select
                  value={form.currency}
                  onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Labeled>
            </div>
            <Labeled label={t('opportunities.expectedClose', 'Expected close date')}>
              <Input
                type="date"
                value={form.expectedCloseDate}
                onChange={(e) => setForm((f) => ({ ...f, expectedCloseDate: e.target.value }))}
              />
            </Labeled>
            <Labeled label={t('opportunities.notes', 'Notes')}>
              <Textarea
                rows={3}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Labeled>
          </div>
          <DialogFooter className="flex items-center justify-between gap-2">
            {form.id ? (
              <div className="flex items-center gap-2 mr-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => winMutation.mutate(form.id!)}
                >
                  <Trophy className="w-4 h-4" aria-hidden="true" />
                  {t('opportunities.win', 'Won')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loseMutation.mutate(form.id!)}
                >
                  <XCircle className="w-4 h-4" aria-hidden="true" />
                  {t('opportunities.lose', 'Lost')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteMutation.mutate(form.id!)}
                >
                  <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              disabled={!form.name.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate(form)}
            >
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
