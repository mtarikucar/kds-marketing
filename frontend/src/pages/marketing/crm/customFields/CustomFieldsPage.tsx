import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Archive, ArchiveRestore, Tags as TagsIcon } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  FilterBar,
  Switch,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui';
import { useCustomFields, useCustomFieldMutations } from '../hooks';
import type { CustomFieldDef } from '../types';
import { CustomFieldFormDialog } from './CustomFieldFormDialog';
import type { CustomFieldFormValues } from '../schemas';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

export default function CustomFieldsPage() {
  const { t } = useTranslation('marketing');
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, isLoading } = useCustomFields(includeArchived);
  const { create, update, archive, restore } = useCustomFieldMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDef | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<CustomFieldDef | null>(null);

  const fields: CustomFieldDef[] = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (f: CustomFieldDef) => {
    setEditing(f);
    setFormOpen(true);
  };

  const handleSubmit = (values: CustomFieldFormValues) => {
    const optionTypes = values.type === 'SELECT' || values.type === 'MULTISELECT';
    if (editing) {
      // key + type are immutable server-side; only send mutable fields.
      update.mutate(
        {
          id: editing.id,
          data: {
            label: values.label,
            required: values.required ?? false,
            ...(optionTypes ? { options: values.options ?? [] } : {}),
          },
        },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(null);
            toast.success(t('crm.cf.updated', { defaultValue: 'Custom field updated' }));
          },
          onError: (e) => toast.error(apiError(e, t('crm.cf.saveError', { defaultValue: 'Failed to save custom field' }))),
        },
      );
    } else {
      create.mutate(
        {
          label: values.label,
          ...(values.key ? { key: values.key } : {}),
          type: values.type,
          required: values.required ?? false,
          ...(optionTypes ? { options: values.options ?? [] } : {}),
        },
        {
          onSuccess: () => {
            setFormOpen(false);
            toast.success(t('crm.cf.created', { defaultValue: 'Custom field created' }));
          },
          onError: (e) => toast.error(apiError(e, t('crm.cf.saveError', { defaultValue: 'Failed to save custom field' }))),
        },
      );
    }
  };

  const columns: ColumnDef<CustomFieldDef, unknown>[] = [
    {
      accessorKey: 'label',
      header: t('crm.cf.label', { defaultValue: 'Label' }),
      cell: ({ row }) => {
        const f = row.original;
        return (
          <div>
            <p className="text-sm font-medium text-foreground">{f.label}</p>
            <code className="text-xs text-muted-foreground">{f.key}</code>
          </div>
        );
      },
    },
    {
      accessorKey: 'type',
      header: t('crm.cf.type', { defaultValue: 'Type' }),
      cell: ({ getValue }) => (
        <Badge tone="info" size="sm">
          {t(`crm.cf.types.${getValue<string>()}`, { defaultValue: getValue<string>() })}
        </Badge>
      ),
    },
    {
      accessorKey: 'required',
      header: t('crm.cf.required', { defaultValue: 'Required' }),
      cell: ({ getValue }) =>
        getValue<boolean>() ? (
          <Badge tone="warning" size="sm">
            {t('crm.cf.required', { defaultValue: 'Required' })}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    {
      id: 'state',
      header: t('crm.cf.state', { defaultValue: 'State' }),
      cell: ({ row }) =>
        row.original.archived ? (
          <Badge tone="neutral" size="sm">
            {t('crm.cf.archived', { defaultValue: 'Archived' })}
          </Badge>
        ) : (
          <Badge tone="success" size="sm">
            {t('crm.cf.active', { defaultValue: 'Active' })}
          </Badge>
        ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const f = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!f.archived && (
                <DropdownMenuItem onClick={() => openEdit(f)}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('common.edit', { defaultValue: 'Edit' })}
                </DropdownMenuItem>
              )}
              {f.archived ? (
                <DropdownMenuItem
                  onClick={() =>
                    restore.mutate(f.id, {
                      onSuccess: () => toast.success(t('crm.cf.restored', { defaultValue: 'Custom field restored' })),
                      onError: (e) => toast.error(apiError(e, 'Failed to restore')),
                    })
                  }
                >
                  <ArchiveRestore className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('crm.cf.restore', { defaultValue: 'Restore' })}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setArchiveTarget(f)}>
                  <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('crm.cf.archive', { defaultValue: 'Archive' })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('crm.cf.title', { defaultValue: 'Custom fields' })}
        description={t('crm.cf.subtitle', {
          defaultValue: 'Define workspace-specific data captured on every lead.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('crm.cf.createTitle', { defaultValue: 'New custom field' })}
          </Button>
        }
      />

      <FilterBar>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={includeArchived} onCheckedChange={setIncludeArchived} />
          {t('crm.cf.showArchived', { defaultValue: 'Show archived' })}
        </label>
      </FilterBar>

      <DataTable
        columns={columns}
        data={fields}
        isLoading={isLoading}
        loadingRowCount={5}
        emptyState={
          <EmptyState
            icon={<TagsIcon className="h-10 w-10" />}
            title={t('crm.cf.empty', { defaultValue: 'No custom fields yet' })}
            description={t('crm.cf.emptyHint', {
              defaultValue: 'Create your first custom field to capture extra data on leads.',
            })}
            action={
              <Button onClick={openCreate} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('crm.cf.createTitle', { defaultValue: 'New custom field' })}
              </Button>
            }
          />
        }
      />

      <CustomFieldFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        field={editing}
        onSubmit={handleSubmit}
        isPending={create.isPending || update.isPending}
      />

      <ConfirmDialog
        open={!!archiveTarget}
        onOpenChange={(o) => {
          if (!o) setArchiveTarget(null);
        }}
        title={t('crm.cf.archiveTitle', { defaultValue: 'Archive custom field' })}
        description={t('crm.cf.archiveDesc', {
          defaultValue:
            'The field is hidden from new leads but existing values are preserved. You can restore it later.',
        })}
        confirmLabel={t('crm.cf.archive', { defaultValue: 'Archive' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={archive.isPending}
        onConfirm={() =>
          archiveTarget &&
          archive.mutate(archiveTarget.id, {
            onSuccess: () => {
              setArchiveTarget(null);
              toast.success(t('crm.cf.archived', { defaultValue: 'Archived' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to archive')),
          })
        }
      />
    </div>
  );
}
