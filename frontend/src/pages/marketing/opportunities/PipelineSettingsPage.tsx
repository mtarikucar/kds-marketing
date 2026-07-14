import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, Star, ArrowUp, ArrowDown, Check, Archive } from 'lucide-react';

import {
  listPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
  addStage,
  updateStage,
  deleteStage,
  reorderStages,
  type Pipeline,
  type PipelineStage,
} from '../../../features/marketing/api/opportunities.service';
import {
  PageHeader,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Input,
  Badge,
  Spinner,
  ConfirmDialog,
} from '@/components/ui';

/** Surface the API's own message (e.g. the pipeline-delete 409) when present. */
function errMessage(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' ? m : fallback;
}

/**
 * Pipeline + stage configuration (GoHighLevel parity, MANAGER+). Create/rename/
 * default/delete pipelines; add/edit/delete/reorder their stages, including the
 * isWon/isLost terminal flags that resolve deals on entry. Route is manager-gated
 * (MarketingProtectedRoute) and the backend enforces leads.manage.
 */
export default function PipelineSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [newPipeline, setNewPipeline] = useState('');
  const [newStage, setNewStage] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);

  const { data: pipelines, isLoading } = useQuery({
    queryKey: ['marketing', 'pipelines'],
    queryFn: listPipelines,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'pipelines'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'opportunities'] });
  };
  const onError = () => toast.error(t('opportunities.saveError', 'Could not save'));

  const createMut = useMutation({
    mutationFn: () => createPipeline({ name: newPipeline.trim() }),
    onSuccess: () => {
      invalidate();
      setNewPipeline('');
      toast.success(t('opportunities.pipelineCreated', 'Pipeline created'));
    },
    onError,
  });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updatePipeline>[1] }) =>
      updatePipeline(id, patch),
    onSuccess: invalidate,
    onError,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePipeline(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('opportunities.pipelineDeleted', 'Pipeline deleted'));
    },
    // Surface the API's reason verbatim — it explains that a pipeline with deals
    // can't be deleted and should be archived (a generic string would mislead).
    onError: (e) =>
      toast.error(
        errMessage(e, t('opportunities.pipelineDeleteError', 'Could not delete this pipeline')),
      ),
  });
  const archiveMut = useMutation({
    mutationFn: (id: string) => updatePipeline(id, { archived: true }),
    onSuccess: () => {
      invalidate();
      toast.success(t('opportunities.pipelineArchived', 'Pipeline archived'));
    },
    onError,
  });

  const addStageMut = useMutation({
    mutationFn: ({ pid, name }: { pid: string; name: string }) => addStage(pid, { name }),
    onSuccess: (_d, v) => {
      invalidate();
      setNewStage((s) => ({ ...s, [v.pid]: '' }));
    },
    onError,
  });
  const updateStageMut = useMutation({
    mutationFn: ({
      pid,
      sid,
      patch,
    }: {
      pid: string;
      sid: string;
      patch: Parameters<typeof updateStage>[2];
    }) => updateStage(pid, sid, patch),
    onSuccess: invalidate,
    onError,
  });
  const deleteStageMut = useMutation({
    mutationFn: ({ pid, sid }: { pid: string; sid: string }) => deleteStage(pid, sid),
    onSuccess: invalidate,
    onError: () =>
      toast.error(t('opportunities.stageDeleteError', 'Stage in use or last stage — cannot delete')),
  });
  const reorderMut = useMutation({
    mutationFn: ({ pid, ids }: { pid: string; ids: string[] }) => reorderStages(pid, ids),
    onSuccess: invalidate,
    onError,
  });

  const moveStage = (p: Pipeline, idx: number, dir: -1 | 1) => {
    const ids = p.stages.map((s) => s.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    reorderMut.mutate({ pid: p.id, ids });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('opportunities.pipelinesTitle', 'Pipelines')}
        description={t('opportunities.pipelinesSubtitle', 'Define the stages deals move through.')}
      />

      {/* New pipeline */}
      <div className="flex items-center gap-2 max-w-md">
        <Input
          value={newPipeline}
          onChange={(e) => setNewPipeline(e.target.value)}
          placeholder={t('opportunities.newPipelinePlaceholder', 'New pipeline name')}
        />
        <Button
          size="md"
          disabled={!newPipeline.trim() || createMut.isPending}
          onClick={() => createMut.mutate()}
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          {t('opportunities.addPipeline', 'Add')}
        </Button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {(pipelines ?? []).map((p) => (
        <Card key={p.id}>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CardTitle>{p.name}</CardTitle>
              {p.isDefault && (
                <Badge tone="primary" size="sm">
                  {t('opportunities.default', 'Default')}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {!p.isDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => updateMut.mutate({ id: p.id, patch: { isDefault: true } })}
                >
                  <Star className="w-4 h-4" aria-hidden="true" />
                  {t('opportunities.makeDefault', 'Make default')}
                </Button>
              )}
              {!p.isDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => archiveMut.mutate(p.id)}
                  disabled={archiveMut.isPending && archiveMut.variables === p.id}
                >
                  <Archive className="w-4 h-4" aria-hidden="true" />
                  {t('opportunities.archive', 'Archive')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('opportunities.deletePipeline', 'Delete pipeline')}
                onClick={() => setDeleteTarget(p)}
              >
                <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {p.stages.map((stage, idx) => (
              <StageRow
                key={stage.id}
                stage={stage}
                first={idx === 0}
                last={idx === p.stages.length - 1}
                onMove={(dir) => moveStage(p, idx, dir)}
                onSave={(patch) => updateStageMut.mutate({ pid: p.id, sid: stage.id, patch })}
                onDelete={() => deleteStageMut.mutate({ pid: p.id, sid: stage.id })}
                t={t}
              />
            ))}

            {/* Add stage */}
            <div className="flex items-center gap-2 pt-1">
              <Input
                value={newStage[p.id] ?? ''}
                onChange={(e) => setNewStage((s) => ({ ...s, [p.id]: e.target.value }))}
                placeholder={t('opportunities.newStagePlaceholder', 'New stage name')}
                className="max-w-xs"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!(newStage[p.id] ?? '').trim()}
                onClick={() => addStageMut.mutate({ pid: p.id, name: (newStage[p.id] ?? '').trim() })}
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                {t('opportunities.addStage', 'Add stage')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('opportunities.deletePipelineTitle', 'Delete pipeline')}
        description={t(
          'opportunities.deletePipelineDesc',
          'This permanently deletes the pipeline and its stages. A pipeline that still has deals (including closed WON/LOST ones) cannot be deleted — archive it instead to keep that history.',
        )}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        tone="danger"
        loading={deleteMut.isPending}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
      />
    </div>
  );
}

function StageRow({
  stage,
  first,
  last,
  onMove,
  onSave,
  onDelete,
  t,
}: {
  stage: PipelineStage;
  first: boolean;
  last: boolean;
  onMove: (dir: -1 | 1) => void;
  onSave: (patch: Partial<PipelineStage>) => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslation<'marketing'>>['t'];
}) {
  const [name, setName] = useState(stage.name);
  const [prob, setProb] = useState(String(stage.probability));
  const dirty = name !== stage.name || prob !== String(stage.probability);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <div className="flex flex-col">
        <button
          type="button"
          disabled={first}
          onClick={() => onMove(-1)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label="up"
        >
          <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={last}
          onClick={() => onMove(1)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label="down"
        >
          <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      <Input value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
      <Input
        type="number"
        min={0}
        max={100}
        value={prob}
        onChange={(e) => setProb(e.target.value)}
        className="w-20"
        title={t('opportunities.probability', 'Win %')}
      />
      <button
        type="button"
        onClick={() => onSave({ isWon: !stage.isWon, isLost: false })}
        className={[
          'px-2 py-1 rounded text-xs',
          stage.isWon ? 'bg-success-subtle text-success' : 'text-muted-foreground hover:bg-surface-muted',
        ].join(' ')}
      >
        {t('opportunities.wonFlag', 'Won')}
      </button>
      <button
        type="button"
        onClick={() => onSave({ isLost: !stage.isLost, isWon: false })}
        className={[
          'px-2 py-1 rounded text-xs',
          stage.isLost ? 'bg-danger-subtle text-danger' : 'text-muted-foreground hover:bg-surface-muted',
        ].join(' ')}
      >
        {t('opportunities.lostFlag', 'Lost')}
      </button>
      {dirty && (
        <Button
          variant="outline"
          size="sm"
          // Coerce to the backend's @IsInt @Min(0) @Max(100) so a typed 150 / 12.5
          // (the input's min/max don't gate this onClick save) can't 400.
          onClick={() =>
            onSave({
              name: name.trim(),
              probability: Math.min(100, Math.max(0, Math.round(Number(prob) || 0))),
            })
          }
        >
          <Check className="w-4 h-4" aria-hidden="true" />
        </Button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="text-muted-foreground hover:text-danger"
        aria-label="delete"
      >
        <Trash2 className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
