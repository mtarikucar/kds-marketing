import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, RefreshCw, Filter } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui';
import { fmtDate } from '../../../../features/marketing/utils/format';
import { useSegments, useSegmentMutations, useCustomFields } from '../hooks';
import type { Segment, SegmentNode } from '../types';
import { SegmentDialog } from './SegmentDialog';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

export default function SegmentsPage() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useSegments();
  const { data: defs } = useCustomFields(false);
  const { create, update, remove, count } = useSegmentMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null);

  const segments: Segment[] = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (s: Segment) => {
    setEditing(s);
    setFormOpen(true);
  };

  const handleSubmit = (values: { name: string; description?: string; definition: SegmentNode }) => {
    if (editing) {
      update.mutate(
        { id: editing.id, data: values },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(null);
            toast.success(t('crm.seg.updated', { defaultValue: 'Segment updated' }));
          },
          onError: (e) => toast.error(apiError(e, t('crm.seg.saveError', { defaultValue: 'Failed to save segment' }))),
        },
      );
    } else {
      create.mutate(values, {
        onSuccess: () => {
          setFormOpen(false);
          toast.success(t('crm.seg.created', { defaultValue: 'Segment created' }));
        },
        onError: (e) => toast.error(apiError(e, t('crm.seg.saveError', { defaultValue: 'Failed to save segment' }))),
      });
    }
  };

  const columns: ColumnDef<Segment, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('crm.seg.name', { defaultValue: 'Name' }),
      cell: ({ row }) => {
        const s = row.original;
        return (
          <div>
            <p className="text-sm font-medium text-foreground">{s.name}</p>
            {s.description && <p className="text-xs text-muted-foreground">{s.description}</p>}
          </div>
        );
      },
    },
    {
      accessorKey: 'lastCount',
      header: t('crm.seg.members', { defaultValue: 'Members' }),
      cell: ({ row }) => {
        const s = row.original;
        return (
          <div className="flex items-center gap-2">
            {s.lastCount == null ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              <Badge tone="primary" size="sm">
                {s.lastCount}
              </Badge>
            )}
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('crm.seg.recount', { defaultValue: 'Recount' })}
              disabled={count.isPending}
              onClick={() =>
                count.mutate(s.id, {
                  onError: (e) => toast.error(apiError(e, 'Recount failed')),
                })
              }
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </div>
        );
      },
    },
    {
      accessorKey: 'lastEvaluatedAt',
      header: t('crm.seg.lastEvaluated', { defaultValue: 'Last evaluated' }),
      cell: ({ getValue }) => {
        const v = getValue<string | null>();
        return <span className="text-sm text-muted-foreground">{v ? fmtDate(v) : '—'}</span>;
      },
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const s = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(s)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(s)}>
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
        title={t('crm.seg.title', { defaultValue: 'Segments' })}
        description={t('crm.seg.subtitle', { defaultValue: 'Saved, live filters over your leads.' })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('crm.seg.createTitle', { defaultValue: 'New segment' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={segments}
        isLoading={isLoading}
        loadingRowCount={5}
        emptyState={
          <EmptyState
            icon={<Filter className="h-10 w-10" />}
            title={t('crm.seg.empty', { defaultValue: 'No segments yet' })}
            description={t('crm.seg.emptyHint', {
              defaultValue: 'Build a segment to group leads by field, tag, or custom-field values.',
            })}
            action={
              <Button onClick={openCreate} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('crm.seg.createTitle', { defaultValue: 'New segment' })}
              </Button>
            }
          />
        }
      />

      <SegmentDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        defs={defs ?? []}
        segment={editing}
        onSubmit={handleSubmit}
        isPending={create.isPending || update.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('crm.seg.deleteTitle', { defaultValue: 'Delete segment' })}
        description={t('crm.seg.deleteDesc', { defaultValue: 'This permanently deletes the segment definition.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() =>
          deleteTarget &&
          remove.mutate(deleteTarget.id, {
            onSuccess: () => {
              setDeleteTarget(null);
              toast.success(t('crm.seg.deleted', { defaultValue: 'Segment deleted' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to delete segment')),
          })
        }
      />
    </div>
  );
}
