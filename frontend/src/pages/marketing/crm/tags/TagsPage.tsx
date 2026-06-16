import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Tag as TagIcon } from 'lucide-react';
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
import { useTags, useTagMutations } from '../hooks';
import type { MarketingTag } from '../types';
import { TagFormDialog } from './TagFormDialog';
import type { TagFormValues } from '../schemas';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

export default function TagsPage() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useTags();
  const { create, update, remove } = useTagMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MarketingTag | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MarketingTag | null>(null);

  const tags: MarketingTag[] = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (tg: MarketingTag) => {
    setEditing(tg);
    setFormOpen(true);
  };

  const handleSubmit = (values: TagFormValues) => {
    const payload = { name: values.name, ...(values.color ? { color: values.color } : {}) };
    if (editing) {
      update.mutate(
        { id: editing.id, data: payload },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(null);
            toast.success(t('crm.tags.updated', { defaultValue: 'Tag updated' }));
          },
          onError: (e) => toast.error(apiError(e, t('crm.tags.saveError', { defaultValue: 'Failed to save tag' }))),
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          setFormOpen(false);
          toast.success(t('crm.tags.created', { defaultValue: 'Tag created' }));
        },
        onError: (e) => toast.error(apiError(e, t('crm.tags.saveError', { defaultValue: 'Failed to save tag' }))),
      });
    }
  };

  const columns: ColumnDef<MarketingTag, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('crm.tags.name', { defaultValue: 'Name' }),
      cell: ({ row }) => {
        const tg = row.original;
        return (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-full border border-border"
              style={{ backgroundColor: tg.color ?? 'transparent' }}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-foreground">{tg.name}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'count',
      header: t('crm.tags.members', { defaultValue: 'Leads' }),
      cell: ({ getValue }) => (
        <Badge tone="neutral" size="sm">
          {getValue<number>() ?? 0}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const tg = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(tg)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(tg)}>
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
        title={t('crm.tags.title', { defaultValue: 'Tags' })}
        description={t('crm.tags.subtitle', { defaultValue: 'Label leads and build segments from tag membership.' })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('crm.tags.createTitle', { defaultValue: 'New tag' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={tags}
        isLoading={isLoading}
        loadingRowCount={5}
        emptyState={
          <EmptyState
            icon={<TagIcon className="h-10 w-10" />}
            title={t('crm.tags.empty', { defaultValue: 'No tags yet' })}
            description={t('crm.tags.emptyHint', { defaultValue: 'Create a tag to start labelling leads.' })}
            action={
              <Button onClick={openCreate} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('crm.tags.createTitle', { defaultValue: 'New tag' })}
              </Button>
            }
          />
        }
      />

      <TagFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        tag={editing}
        onSubmit={handleSubmit}
        isPending={create.isPending || update.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('crm.tags.deleteTitle', { defaultValue: 'Delete tag' })}
        description={t('crm.tags.deleteDesc', {
          defaultValue: 'This removes the tag from all leads. This action cannot be undone.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() =>
          deleteTarget &&
          remove.mutate(deleteTarget.id, {
            onSuccess: () => {
              setDeleteTarget(null);
              toast.success(t('crm.tags.deleted', { defaultValue: 'Tag deleted' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to delete tag')),
          })
        }
      />
    </div>
  );
}
