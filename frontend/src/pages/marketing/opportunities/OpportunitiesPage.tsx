import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Settings, Trophy, XCircle, Trash2, GripVertical, TrendingUp, ChevronDown } from 'lucide-react';
import { useCreateParam } from '../../../features/marketing/hooks/useCreateParam';
import { fmtSlot } from '../../../features/marketing/utils/format';

import {
  getBoard,
  getForecast,
  getOpportunity,
  listNotInPipeline,
  listPipelines,
  createOpportunity,
  updateOpportunity,
  moveOpportunity,
  winOpportunity,
  loseOpportunity,
  deleteOpportunity,
  type Board,
  type BoardOpportunity,
  type BoardStage,
  type Forecast,
  type Opportunity,
  type PersonCard,
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
  QueryStateBoundary,
  Skeleton,
} from '@/components/ui';

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

/**
 * How many people the "Hatta değil" column asks for at a time.
 *
 * The affordance is LOAD-MORE (append), not numbered pages, and that is a
 * decision about the gesture rather than about the DOM. This column exists to
 * be dragged OUT of: with a pager, surfacing person #21 means walking to page 2
 * — and the moment you drop one, the column re-reads, everyone shifts up a slot
 * and the page you were on is a different set of people. Appending keeps
 * everything already surfaced on screen, so a drop removes exactly one card
 * from a list you built yourself. It bounds the first paint just as hard (20
 * cards, never 361) and grows only when someone asks.
 */
const NOT_IN_PIPELINE_PAGE = 20;

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
  /** The contact this deal belongs to. Set only by the lead detail page's
   *  `?leadId=` deep link — a deal created from the board itself has none. */
  leadId?: string;
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

  // The lead detail page's Satış tab links in with `?pipelineId=` so a deal
  // outside the default pipeline lands on the board that actually holds it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [pipelineId, setPipelineId] = useState<string | undefined>(
    () => searchParams.get('pipelineId') ?? undefined,
  );
  /**
   * What is in hand. Two KINDS travel across this board now — an existing deal
   * moving between stages, and a PERSON being pulled out of "Hatta değil" to
   * open their first one — and they end in two different requests. A bare id
   * would make the drop handler guess from whichever list happens to contain
   * it, which is the same id-space confusion that once dialled lead A's number
   * under lead B's id.
   */
  const [drag, setDrag] = useState<{ kind: 'deal' | 'person'; id: string } | null>(null);
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

  /**
   * The leftmost column: everyone with no OPEN deal. 361 of them on the live
   * workspace, and until now they appeared on no screen at all.
   *
   * Deliberately NOT keyed by pipeline. "In the pipeline" is `status = 'OPEN'`
   * on ANY deal, so flipping the pipeline selector does not change who is
   * outside — keying it would refetch the same answer under a second key and
   * invite the two to disagree.
   */
  const outside = useInfiniteQuery({
    queryKey: ['marketing', 'opportunities', 'not-in-pipeline'],
    queryFn: ({ pageParam }) =>
      listNotInPipeline({ page: pageParam, limit: NOT_IN_PIPELINE_PAGE }),
    initialPageParam: 1,
    // Optional-chained on purpose: this callback runs inside React Query's
    // reducer, so a throw here blanks the WHOLE board rather than failing one
    // column. A payload without `meta` costs the "Daha fazla" button; it does
    // not cost the pipeline.
    getNextPageParam: (last) =>
      last?.meta && last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
  });

  const outsiders: PersonCard[] = useMemo(
    () => (outside.data?.pages ?? []).flatMap((p) => p?.data ?? []),
    [outside.data],
  );
  // The count is the COLUMN, not the screenful: `meta.total` is the full figure
  // on every page, so this reads 361 while twenty cards are drawn. Undefined
  // until a page has actually arrived — a failed read must never render as 0.
  const outsiderTotal = outside.data?.pages.at(-1)?.meta?.total;

  const invalidateBoard = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'opportunities'] });
  };

  const moveMutation = useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) => moveOpportunity(id, stageId),
    onSuccess: invalidateBoard,
    onError: () => toast.error(t('opportunities.moveError', 'Could not move the deal')),
  });

  /**
   * A person dragged out of "Hatta değil" onto a stage. Reuses the ONE creation
   * endpoint with no `name` — the backend falls back to the person's own — so
   * this gesture is not a second creation path with its own idea of what a deal
   * is called.
   */
  const openForPerson = useMutation({
    mutationFn: ({ leadId, stageId }: { leadId: string; stageId: string }) =>
      createOpportunity({ leadId, pipelineId: activePipelineId, stageId }),
    onSuccess: invalidateBoard,
    onError: () =>
      toast.error(t('opportunities.dealForPersonFailed', 'Bu kişi için fırsat açılamadı')),
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
            // Carried from `?leadId=`. Without it a deal created from a lead's
            // Satış tab is filed against nobody: the board looks right and the
            // contact's record still reads "no deal for this contact".
            leadId: f.leadId,
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
      // Close the dialog like save/delete do — the deal is now WON and leaves the
      // OPEN-only board, so leaving the dialog open strands it on a hidden deal.
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('opportunities.markedWon', 'Marked as won'));
    },
    onError: () => toast.error(t('opportunities.winError', 'Could not mark the deal as won')),
  });
  const loseMutation = useMutation({
    mutationFn: (id: string) => loseOpportunity(id),
    onSuccess: () => {
      invalidateBoard();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
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

  /**
   * "Son temas" — the newest message on any of this person's threads.
   *
   * The third thing a card carries, and the one the design named alongside the
   * value (2026-08-30 §1: name primary, deal value and last contact secondary).
   * A name and a number say who and how much; only this says whether anyone has
   * spoken to them — which on the "Hatta değil" column IS the decision.
   *
   * `fmtSlot`, the helper this surface already reads dates with, because a board
   * is a COLUMN of these: the year and the seconds are identical on every card
   * and only push the name off the line.
   *
   * Silence gets WORDS. An empty slot reads as "not loaded yet" on a card whose
   * whole point is that nobody has done anything here, and any date standing in
   * for "never" would simply be false.
   *
   * The test id deliberately does NOT start with `person-card-`/`deal-card-`:
   * `getAllByTestId(/^person-card-/)` is how the column counts its CARDS, and a
   * second node per card under that prefix doubles the count silently.
   */
  const lastContact = (at: string | null, testId: string) => (
    <p data-testid={testId} className="text-micro text-muted-foreground truncate">
      {at
        ? `${t('opportunities.card.lastContact', 'Son temas')}: ${fmtSlot(at)}`
        : t('opportunities.card.noContact', 'Henüz temas yok')}
    </p>
  );

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

  const openNew = (stageId?: string, leadId?: string) => {
    setForm({ ...EMPTY_FORM, stageId, leadId });
    setDialogOpen(true);
  };

  // Honor ?create=1 from the global "+ Create" menu / command palette — and,
  // from a lead's Satış tab, the `?leadId=` that says who the deal is for. Read
  // into form state at open time rather than at save time, so the param lingering
  // in the URL cannot silently attach that lead to the NEXT deal created here.
  useCreateParam(() => openNew(undefined, searchParams.get('leadId') ?? undefined));
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

  // ── `?deal=` — open one deal, from anywhere ────────────────────────────────
  // The Satış tab's rows link here. Resolved by ID rather than by scanning the
  // board on purpose: the board is OPEN-only and renders ONE pipeline, so a WON
  // deal (or one in another pipeline) is not on it — a board-scan would leave
  // the dialog silently unopened on a page that otherwise looks fine.
  const dealParam = searchParams.get('deal');
  const deepLink = useQuery({
    queryKey: ['marketing', 'opportunity', dealParam],
    queryFn: () => getOpportunity(dealParam!),
    enabled: !!dealParam,
  });
  const openedDealRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dealParam || !deepLink.data) return;
    if (openedDealRef.current === dealParam) return;
    openedDealRef.current = dealParam;
    openEdit(deepLink.data);
    // Strip the param so a refresh or a back-navigation does not re-open it.
    setSearchParams(
      (p) => {
        p.delete('deal');
        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealParam, deepLink.data]);
  // A deal that cannot be fetched must SAY so. Falling through to the board
  // would answer "here is your pipeline" to "open this deal", and the user
  // would have no way to tell the link was dead.
  useEffect(() => {
    if (deepLink.isError) toast.error(t('opportunities.dealNotFound', 'Fırsat açılamadı'));
  }, [deepLink.isError, t]);

  const onDrop = (stage: BoardStage) => {
    setOverStage(null);
    const held = drag;
    setDrag(null);
    if (!held) return;

    if (held.kind === 'person') {
      // Creating a deal directly in a terminal stage resolves it WON/LOST on
      // the backend, so it would leave this OPEN-only board immediately while
      // silently entering won/lost reporting. "+ Add" already refuses that;
      // the drag refuses it too, and says so rather than doing nothing.
      if (stage.isWon || stage.isLost) {
        toast.error(
          t(
            'opportunities.terminalDropRefused',
            'Kişiyi doğrudan Kazanıldı/Kaybedildi sütununa bırakamazsın.',
          ),
        );
        return;
      }
      openForPerson.mutate({ leadId: held.id, stageId: stage.id });
      return;
    }

    const from = board?.stages.find((s) => s.opportunities.some((o) => o.id === held.id));
    if (from?.id === stage.id) return; // same column — no-op
    moveMutation.mutate({ id: held.id, stageId: stage.id });
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
      <div className="flex flex-wrap items-center justify-between gap-3">
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
                  <div className="w-24 shrink-0 sm:w-40 truncate">
                    {s.name} <span className="text-muted-foreground">· {s.probability}%</span>
                  </div>
                  <div className="flex-1 h-2 rounded-full bg-surface-muted overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                  <div className="w-24 shrink-0 sm:w-40 text-right tabular-nums">
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

      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('opportunities.loadFailed', 'Could not load the board.')}
        retryLabel={t('common.retry', 'Retry')}
      />

      {/* Kanban columns */}
      {board && !isError && (
        <div data-testid="board-columns" className="flex gap-3 overflow-x-auto pb-4">
          {/* ── Hatta değil ───────────────────────────────────────────────────
              Leftmost, and first in the DOM, because it is the biggest column
              on the board: 361 people against 2 deals. A board open only to
              people who already have a deal keeps the silent majority silent —
              which is exactly the state that made this pipeline empty.

              A SOURCE, never a destination: nothing is dropped back into it, so
              it carries no drop handler. A deal leaves this column by being
              opened, not by being dragged out of a stage. */}
          <div
            data-testid="column-not-in-pipeline"
            className="flex-shrink-0 w-72 rounded-lg border border-dashed border-border bg-surface-muted/40 p-2"
          >
            <div className="flex items-center justify-between px-1 py-1.5">
              <span className="font-medium text-sm text-foreground">
                {t('opportunities.notInPipeline.title', 'Hatta değil')}
              </span>
              {/* Absent — not zero — until a page has actually arrived. */}
              {outsiderTotal !== undefined && (
                <Badge data-testid="not-in-pipeline-count" tone="neutral" size="sm">
                  {outsiderTotal}
                </Badge>
              )}
            </div>

            {/* A column that could not be read must never wear the face of a
                column with nobody in it — saying "0 kişi" to a failed request
                is the exact lie this column exists to stop telling. */}
            <QueryStateBoundary
              isLoading={outside.isLoading}
              isError={outside.isError}
              onRetry={() => outside.refetch()}
              errorMessage={t(
                'opportunities.notInPipeline.failed',
                'Hatta olmayanlar okunamadı.',
              )}
              retryLabel={t('common.retry', 'Retry')}
              loading={
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 rounded-md" />
                  ))}
                </div>
              }
            >
              {outsiders.length === 0 ? (
                <p
                  data-testid="not-in-pipeline-empty"
                  className="px-1 py-2 text-caption text-muted-foreground"
                >
                  {t('opportunities.notInPipeline.empty', 'Herkes hatta.')}
                </p>
              ) : (
                <div className="space-y-2 min-h-[40px]">
                  {outsiders.map((p) => (
                    <div
                      key={p.id}
                      data-testid={`person-card-${p.id}`}
                      draggable
                      onDragStart={() => setDrag({ kind: 'person', id: p.id })}
                      onDragEnd={() => setDrag(null)}
                      className={[
                        'group rounded-md border border-border bg-surface p-2.5 shadow-sm cursor-grab hover:border-primary/50',
                        drag?.kind === 'person' && drag.id === p.id ? 'opacity-50' : '',
                      ].join(' ')}
                    >
                      <div className="flex items-start gap-1.5">
                        <GripVertical
                          className="w-3.5 h-3.5 mt-0.5 text-muted-foreground opacity-0 group-hover:opacity-100"
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          {/* `name` is computed server-side by the same rule the
                              person list uses, and it may be empty — a lead with
                              neither field set is legal. Falling through to the
                              phone rather than drawing a blank card. */}
                          <p className="text-sm font-medium text-foreground truncate">
                            {p.name ||
                              p.phone ||
                              t('opportunities.card.unnamed', 'İsimsiz kişi')}
                          </p>
                          {p.contactPerson && p.businessName && (
                            <p className="text-caption text-muted-foreground truncate mt-0.5">
                              {p.businessName}
                            </p>
                          )}
                          {lastContact(p.lastMessageAt, `person-contact-${p.id}`)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {outside.hasNextPage && (
                <button
                  type="button"
                  onClick={() => outside.fetchNextPage()}
                  disabled={outside.isFetchingNextPage}
                  className="mt-2 w-full rounded-md py-1.5 text-xs text-muted-foreground hover:text-primary hover:bg-surface disabled:opacity-50"
                >
                  {t('opportunities.notInPipeline.more', 'Daha fazla')}
                </button>
              )}
            </QueryStateBoundary>
          </div>

          {board.stages.map((stage) => (
            <div
              key={stage.id}
              data-testid={`column-${stage.id}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage.id);
              }}
              onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
              onDrop={() => onDrop(stage)}
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
                {stage.opportunities.map((o: BoardOpportunity) => (
                  <div
                    key={o.id}
                    data-testid={`deal-card-${o.id}`}
                    draggable
                    onDragStart={() => setDrag({ kind: 'deal', id: o.id })}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => openEdit(o)}
                    className={[
                      'group rounded-md border border-border bg-surface p-2.5 shadow-sm cursor-pointer hover:border-primary/50',
                      drag?.kind === 'deal' && drag.id === o.id ? 'opacity-50' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical
                        className="w-3.5 h-3.5 mt-0.5 text-muted-foreground opacity-0 group-hover:opacity-100"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        {/* The PERSON is the headline (design 2026-08-30): the
                            daily work runs from the human, and the board stands
                            for forecast and overview. */}
                        {o.lead ? (
                          <p
                            data-testid={`deal-card-person-${o.id}`}
                            className="text-sm font-medium text-foreground truncate"
                          >
                            {o.lead.name ||
                              o.lead.phone ||
                              t('opportunities.card.unnamed', 'İsimsiz kişi')}
                          </p>
                        ) : (
                          // A deal attached to nobody is worth SEEING, not
                          // hiding: `leadId` has no foreign key, so this is
                          // either a deal filed against no one or one naming a
                          // person this workspace cannot resolve. Hiding it
                          // would shrink the board out from under a forecast
                          // that still counts it.
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-medium text-foreground truncate">{o.name}</p>
                            <Badge
                              data-testid={`deal-card-nobody-${o.id}`}
                              tone="warning"
                              size="sm"
                            >
                              {t('opportunities.card.nobody', 'Kişisiz')}
                            </Badge>
                          </div>
                        )}
                        <p className="text-caption text-muted-foreground mt-0.5">
                          {money(o.value, o.currency)}
                        </p>
                        {/* Secondary, but present: one person may be carrying
                            two deals, and the card still has to say which — and
                            when they were last spoken to. */}
                        {o.lead && (
                          <>
                            <p className="text-micro text-muted-foreground truncate">{o.name}</p>
                            {lastContact(o.lead.lastMessageAt, `deal-contact-${o.id}`)}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Never offer "+ Add" on a terminal (Won/Lost) column: creating
                  a deal directly in a terminal stage resolves it WON/LOST on the
                  backend, so it vanishes from this OPEN-only board while silently
                  entering won/lost reporting. Deals reach terminal stages only via
                  drag or the explicit Win/Lost buttons. */}
              {!stage.isWon && !stage.isLost && (
                <button
                  type="button"
                  onClick={() => openNew(stage.id)}
                  className="mt-2 w-full flex items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted-foreground hover:text-primary hover:bg-surface"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  {t('opportunities.add', 'Add')}
                </button>
              )}
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
