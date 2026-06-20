import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Settings, Trophy, XCircle, Trash2, GripVertical } from 'lucide-react';

import {
  getBoard,
  listPipelines,
  createOpportunity,
  updateOpportunity,
  moveOpportunity,
  winOpportunity,
  loseOpportunity,
  deleteOpportunity,
  type Board,
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
}

const EMPTY_FORM: OppFormState = { name: '', value: '', currency: 'TRY', notes: '' };

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
          })
        : createOpportunity({
            name: f.name,
            pipelineId: activePipelineId,
            stageId: f.stageId,
            value: f.value === '' ? undefined : Number(f.value),
            currency: f.currency,
            notes: f.notes || undefined,
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
  });
  const loseMutation = useMutation({
    mutationFn: (id: string) => loseOpportunity(id),
    onSuccess: () => {
      invalidateBoard();
      toast.success(t('opportunities.markedLost', 'Marked as lost'));
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteOpportunity(id),
    onSuccess: () => {
      invalidateBoard();
      setDialogOpen(false);
      toast.success(t('opportunities.deleted', 'Deal deleted'));
    },
  });

  const boardTotal = useMemo(
    () => (board?.stages ?? []).reduce((sum, s) => sum + s.totalValue, 0),
    [board],
  );
  const boardCurrency = board?.stages.find((s) => s.opportunities[0])?.opportunities[0]?.currency ?? 'TRY';

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
        {board && (
          <p className="text-sm text-muted-foreground">
            {t('opportunities.openTotal', 'Open total')}: {money(boardTotal, boardCurrency)}
          </p>
        )}
      </div>

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
                  {money(stage.totalValue, boardCurrency)}
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
