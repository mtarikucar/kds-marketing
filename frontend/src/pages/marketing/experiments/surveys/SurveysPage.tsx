import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Send, Lock, MessagesSquare, Pencil, Trash2, ClipboardList } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDate } from '../../../../features/marketing/utils/format';
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
import { SurveyFormDialog } from './SurveyFormDialog';
import { SurveyResponsesDialog } from './SurveyResponsesDialog';
import type { SurveyFormValues } from '../schemas';
import type { Survey, SurveyQuestion } from '../types';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  PUBLISHED: 'success',
  CLOSED: 'warning',
};

function toPayload(values: SurveyFormValues) {
  const questions: SurveyQuestion[] = values.questions.map((q) => {
    const needsOptions = q.type === 'SINGLE' || q.type === 'MULTIPLE';
    return {
      key: q.key.trim(),
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      ...(needsOptions
        ? {
            options: (q.options ?? '')
              .split(',')
              .map((o) => o.trim())
              .filter(Boolean),
          }
        : {}),
    };
  });
  return {
    name: values.name,
    questions,
    ...(values.redirectUrl ? { redirectUrl: values.redirectUrl } : { redirectUrl: undefined }),
  };
}

export default function SurveysPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Survey | null>(null);
  const [responsesTarget, setResponsesTarget] = useState<Survey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Survey | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'surveys'],
    queryFn: () => marketingApi.get('/surveys').then((r) => r.data),
  });

  const surveys: Survey[] = Array.isArray(data) ? data : data?.data || [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'surveys'] });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/surveys', payload),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('surveys.createSuccess', { defaultValue: 'Survey created' }));
    },
    onError: () => toast.error(t('surveys.createError', { defaultValue: 'Failed to create survey' })),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/surveys/${id}`, data),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('surveys.updateSuccess', { defaultValue: 'Survey updated' }));
    },
    onError: () => toast.error(t('surveys.updateError', { defaultValue: 'Failed to update survey' })),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      marketingApi.patch(`/surveys/${id}`, { status }),
    onSuccess: (_res, vars) => {
      invalidate();
      toast.success(
        vars.status === 'PUBLISHED'
          ? t('surveys.publishSuccess', { defaultValue: 'Survey published' })
          : t('surveys.closeSuccess', { defaultValue: 'Survey closed' }),
      );
    },
    onError: () => toast.error(t('surveys.statusError', { defaultValue: 'Failed to update status' })),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/surveys/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('surveys.deleteSuccess', { defaultValue: 'Survey deleted' }));
    },
    onError: () => toast.error(t('surveys.deleteError', { defaultValue: 'Failed to delete survey' })),
  });

  const handleSubmit = (values: SurveyFormValues) => {
    const payload = toPayload(values);
    if (editing) updateMutation.mutate({ id: editing.id, data: payload });
    else createMutation.mutate(payload);
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (s: Survey) => {
    setEditing(s);
    setFormOpen(true);
  };
  const handleDialogClose = (open: boolean) => {
    setFormOpen(open);
    if (!open) setEditing(null);
  };

  const columns: ColumnDef<Survey, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('surveys.table.name', { defaultValue: 'Name' }),
      cell: ({ row }) => <span className="text-sm font-medium text-foreground">{row.original.name}</span>,
    },
    {
      id: 'questions',
      header: t('surveys.table.questions', { defaultValue: 'Questions' }),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground tabular-nums">
          {(row.original.questions ?? []).length}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: t('surveys.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={STATUS_TONE[val] ?? 'neutral'} size="sm">
            {t(`surveys.status.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: t('surveys.table.created', { defaultValue: 'Created' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">{fmtDate(getValue<string>())}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const survey = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setResponsesTarget(survey)}>
                <MessagesSquare className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('surveys.viewResponses', { defaultValue: 'View responses' })}
              </DropdownMenuItem>
              {survey.status !== 'PUBLISHED' ? (
                <DropdownMenuItem onClick={() => statusMutation.mutate({ id: survey.id, status: 'PUBLISHED' })}>
                  <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('surveys.publish', { defaultValue: 'Publish' })}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => statusMutation.mutate({ id: survey.id, status: 'CLOSED' })}>
                  <Lock className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('surveys.close', { defaultValue: 'Close' })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => openEdit(survey)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(survey)}>
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
        title={t('surveys.title', { defaultValue: 'Surveys' })}
        description={t('surveys.subtitle', {
          defaultValue: 'Build surveys, publish them, and review the responses you collect.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('surveys.createButton', { defaultValue: 'New survey' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={surveys}
        isLoading={isLoading}
        loadingRowCount={6}
        emptyState={
          <EmptyState
            icon={<ClipboardList className="h-10 w-10" />}
            title={t('surveys.empty', { defaultValue: 'No surveys yet' })}
            description={t('surveys.emptyHint', {
              defaultValue: 'Create a survey with at least one question, then publish it to collect responses.',
            })}
            action={
              <Button onClick={openCreate} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('surveys.createButton', { defaultValue: 'New survey' })}
              </Button>
            }
          />
        }
      />

      <SurveyFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        survey={editing}
        onSubmit={handleSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      <SurveyResponsesDialog
        open={!!responsesTarget}
        onOpenChange={(open) => { if (!open) setResponsesTarget(null); }}
        survey={responsesTarget}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('surveys.deleteTitle', { defaultValue: 'Delete survey' })}
        description={t('surveys.deleteDesc', {
          defaultValue: 'This permanently removes the survey and its responses.',
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
