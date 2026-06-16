import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ShieldCheck, UserCog } from 'lucide-react';
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
import { useRoles, usePermissionCatalog, useRoleAssignTargets, useRoleMutations } from './hooks';
import { permissionMeta, type CustomRole } from './types';
import { RoleFormDialog, type RoleFormValues } from './RoleFormDialog';
import { AssignRoleDialog } from './AssignRoleDialog';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

export default function RolesPage() {
  const { t } = useTranslation('marketing');

  const { data: roles, isLoading } = useRoles();
  const { data: catalog, isLoading: catalogLoading } = usePermissionCatalog();
  const { data: users, isLoading: usersLoading } = useRoleAssignTargets();
  const { create, update, remove, assign } = useRoleMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomRole | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);

  const rows: CustomRole[] = roles ?? [];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (r: CustomRole) => {
    setEditing(r);
    setFormOpen(true);
  };

  const handleSubmit = (values: RoleFormValues) => {
    if (editing) {
      update.mutate(
        { id: editing.id, data: { name: values.name, permissions: values.permissions } },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(null);
            toast.success(t('roles.updated', { defaultValue: 'Role updated' }));
          },
          onError: (e) => toast.error(apiError(e, t('roles.saveError', { defaultValue: 'Failed to save role' }))),
        },
      );
    } else {
      create.mutate(
        { name: values.name, permissions: values.permissions },
        {
          onSuccess: () => {
            setFormOpen(false);
            toast.success(t('roles.created', { defaultValue: 'Role created' }));
          },
          onError: (e) => toast.error(apiError(e, t('roles.saveError', { defaultValue: 'Failed to save role' }))),
        },
      );
    }
  };

  const handleAssign = (payload: { userId: string; roleId: string | null }) => {
    assign.mutate(payload, {
      onSuccess: () => {
        setAssignOpen(false);
        toast.success(t('roles.assigned', { defaultValue: 'Role assigned' }));
      },
      onError: (e) => toast.error(apiError(e, t('roles.assignError', { defaultValue: 'Failed to assign role' }))),
    });
  };

  const columns: ColumnDef<CustomRole, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('roles.name', { defaultValue: 'Role' }),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">{row.original.name}</span>
        </div>
      ),
    },
    {
      id: 'permissions',
      header: t('roles.permissions', { defaultValue: 'Permissions' }),
      cell: ({ row }) => {
        const perms = row.original.permissions ?? [];
        if (perms.length === 0) {
          return <span className="text-sm text-muted-foreground">{t('roles.noPerms', { defaultValue: 'No permissions' })}</span>;
        }
        const shown = perms.slice(0, 4);
        const extra = perms.length - shown.length;
        return (
          <div className="flex flex-wrap gap-1">
            {shown.map((p) => (
              <Badge key={p} tone="info" size="sm">
                {t(`roles.perm.${p}.label`, { defaultValue: permissionMeta(p).label })}
              </Badge>
            ))}
            {extra > 0 && (
              <Badge tone="neutral" size="sm">
                +{extra}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(r)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(r)}>
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
        title={t('roles.title', { defaultValue: 'Roles & permissions' })}
        description={t('roles.subtitle', {
          defaultValue: 'Define custom roles from the permission catalog and assign them to your team.',
        })}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setAssignOpen(true)}>
              <UserCog className="h-4 w-4" aria-hidden="true" />
              {t('roles.assignTitle', { defaultValue: 'Assign a role' })}
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('roles.createTitle', { defaultValue: 'New role' })}
            </Button>
          </div>
        }
      />

      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        loadingRowCount={4}
        emptyState={
          <EmptyState
            icon={<ShieldCheck className="h-10 w-10" />}
            title={t('roles.empty', { defaultValue: 'No custom roles yet' })}
            description={t('roles.emptyHint', {
              defaultValue: 'Create a role to grant a tailored set of permissions beyond the base roles.',
            })}
            action={
              <Button onClick={openCreate} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('roles.createTitle', { defaultValue: 'New role' })}
              </Button>
            }
          />
        }
      />

      <RoleFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        role={editing}
        catalog={catalog ?? []}
        catalogLoading={catalogLoading}
        onSubmit={handleSubmit}
        isPending={create.isPending || update.isPending}
      />

      <AssignRoleDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        users={users ?? []}
        usersLoading={usersLoading}
        roles={rows}
        onSubmit={handleAssign}
        isPending={assign.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('roles.deleteTitle', { defaultValue: 'Delete role' })}
        description={t('roles.deleteDesc', {
          defaultValue:
            'Members holding this role revert to their base role. This cannot be undone.',
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
              toast.success(t('roles.deleted', { defaultValue: 'Role deleted' }));
            },
            onError: (e) => toast.error(apiError(e, t('roles.deleteError', { defaultValue: 'Failed to delete role' }))),
          })
        }
      />
    </div>
  );
}
