import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Play, Square, BarChart3, Pencil, Trash2, FlaskConical } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { fmtDate } from '../../../features/marketing/utils/format';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui';
import { ExperimentFormDialog } from './ExperimentFormDialog';
import { ExperimentResultsDialog } from './ExperimentResultsDialog';
import type { ExperimentFormValues } from './schemas';
import type { Experiment } from './types';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  RUNNING: 'success',
  STOPPED: 'warning',
};

function toPayload(values: ExperimentFormValues) {
  return {
    name: values.name,
    ...(values.pageId ? { pageId: values.pageId } : { pageId: undefined }),
    variants: values.variants.map((v) => ({
      key: v.key.trim(),
      ...(v.label ? { label: v.label } : {}),
      weight: v.weight,
    })),
  };
}

export default function ExperimentsPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Experiment | null>(null);
  const [resultsTarget, setResultsTarget] = useState<Experiment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Experiment | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'experiments'],
    queryFn: () => marketingApi.get('/experiments').then((r) => r.data),
  });

  const experiments: Experiment[] = Array.isArray(data) ? data : data?.data || [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'experiments'] });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/experiments', payload),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('experiments.createSuccess', { defaultValue: 'Experiment created' }));
    },
    onError: () => toast.error(t('experiments.createError', { defaultValue: 'Failed to create experiment' })),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/experiments/${id}`, data),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('experiments.updateSuccess', { defaultValue: 'Experiment updated' }));
    },
    onError: () => toast.error(t('experiments.updateError', { defaultValue: 'Failed to update experiment' })),
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/experiments/${id}/start`),
    onSuccess: () => {
      invalidate();
      toast.success(t('experiments.startSuccess', { defaultValue: 'Experiment started' }));
    },
    onError: () =>
      toast.error(
        t('experiments.startError', { defaultValue: 'Could not start — at least 2 variants are required' }),
      ),
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/experiments/${id}/stop`),
    onSuccess: () => {
      invalidate();
      toast.success(t('experiments.stopSuccess', { defaultValue: 'Experiment stopped' }));
    },
    onError: () => toast.error(t('experiments.stopError', { defaultValue: 'Failed to stop experiment' })),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/experiments/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('experiments.deleteSuccess', { defaultValue: 'Experiment deleted' }));
    },
    onError: () => toast.error(t('experiments.deleteError', { defaultValue: 'Failed to delete experiment' })),
  });

  const handleSubmit = (values: ExperimentFormValues) => {
    const payload = toPayload(values);
    if (editing) updateMutation.mutate({ id: editing.id, data: payload });
    else createMutation.mutate(payload);
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (e: Experiment) => {
    setEditing(e);
    setFormOpen(true);
  };
  const handleDialogClose = (open: boolean) => {
    setFormOpen(open);
    if (!open) setEditing(null);
  };

  const columns: ColumnDef<Experiment, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('experiments.table.name', { defaultValue: 'Name' }),
      cell: ({ row }) => <span className="text-sm font-medium text-foreground">{row.original.name}</span>,
    },
    {
      id: 'variants',
      header: t('experiments.table.variants', { defaultValue: 'Variants' }),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground tabular-nums">
          {(row.original.variants ?? []).length}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: t('experiments.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={STATUS_TONE[val] ?? 'neutral'} size="sm">
            {t(`experiments.status.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: t('experiments.table.created', { defaultValue: 'Created' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">{fmtDate(getValue<string>())}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const exp = row.original;
        const canStart = (exp.variants ?? []).length >= 2;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setResultsTarget(exp)}>
                <BarChart3 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('experiments.viewResults', { defaultValue: 'View results' })}
              </DropdownMenuItem>
              {exp.status !== 'RUNNING' ? (
                <DropdownMenuItem disabled={!canStart} onClick={() => startMutation.mutate(exp.id)}>
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('experiments.start', { defaultValue: 'Start' })}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => stopMutation.mutate(exp.id)}>
                  <Square className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('experiments.stop', { defaultValue: 'Stop' })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => openEdit(exp)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(exp)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.delete', { defaultValue: 'Delete' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('experiments.title', { defaultValue: 'A/B Experiments' })}
        description={t('experiments.subtitle', {
          defaultValue: 'Split traffic across weighted variants and measure conversions.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('experiments.createButton', { defaultValue: 'New experiment' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={experiments}
        isLoading={isLoading}
        loadingRowCount={6}
        emptyState={
          <EmptyState
            icon={<FlaskConical className="h-10 w-10" />}
            title={t('experiments.empty', { defaultValue: 'No experiments yet' })}
            description={t('experiments.emptyHint', {
              defaultValue: 'Create an A/B experiment with at least two variants to start testing.',
            })}
            action={
              <Button onClick={openCreate} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('experiments.createButton', { defaultValue: 'New experiment' })}
              </Button>
            }
          />
        }
      />

      <ExperimentFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        experiment={editing}
        onSubmit={handleSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      <ExperimentResultsDialog
        open={!!resultsTarget}
        onOpenChange={(open) => { if (!open) setResultsTarget(null); }}
        experiment={resultsTarget}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('experiments.deleteTitle', { defaultValue: 'Delete experiment' })}
        description={t('experiments.deleteDesc', {
          defaultValue: 'This permanently removes the experiment and its recorded events.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
