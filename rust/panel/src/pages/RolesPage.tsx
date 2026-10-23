import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createRole, deleteRole, listRoles, updateRole } from '@/api/roles';
import type { Permission, RoleDef } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { PermissionList } from '@/components/PermissionList';
import { PermissionPicker } from '@/components/PermissionPicker';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { can, roleLabel } from '@/lib/roles';

const ROLES_KEY = ['roles'] as const;

/** Create (no `role`) or edit the permissions of a custom role. */
function RoleDialog({
  open,
  role,
  onOpenChange,
}: {
  open: boolean;
  role: RoleDef | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const chosen = permissions ?? role?.permissions ?? [];

  const save = useMutation({
    mutationFn: async () =>
      role ? updateRole(role.id, chosen) : createRole({ key: key.trim(), name: name.trim(), permissions: chosen }),
    onSuccess: async () => {
      toast.success(t('roles.saved'));
      await queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      close(false);
    },
  });

  function close(next: boolean) {
    if (!next) {
      setKey('');
      setName('');
      setPermissions(null);
      save.reset();
    }
    onOpenChange(next);
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {role
              ? t('roles.dialog.editTitle', { name: roleLabel(t, role.key, role.name) })
              : t('roles.dialog.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('roles.dialog.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <ErrorCallout error={save.error} />
          {!role && (
            <>
              <Field label={t('fields.name')} required>
                {(ids) => (
                  <Input id={ids.id} required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
                )}
              </Field>
              <Field label={t('fields.key')} hint={t('roles.dialog.keyHint')} required>
                {(ids) => (
                  <Input
                    id={ids.id}
                    aria-describedby={ids.describedBy}
                    required
                    pattern="[a-z0-9_]{2,32}"
                    maxLength={32}
                    className="font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          <PermissionPicker legend={t('fields.permissions')} value={chosen} onChange={setPermissions} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {role ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const canManage = can(session.data, 'team.manage');
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: listRoles });
  const [editing, setEditing] = useState<{ role: RoleDef | null } | null>(null);
  const [deleting, setDeleting] = useState<RoleDef | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteRole(id),
    onSuccess: async () => {
      setDeleting(null);
      toast.success(t('roles.deleted'));
      await queryClient.invalidateQueries({ queryKey: ROLES_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const columns = useMemo<ColumnDef<RoleDef, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('roles.columns.name'),
        accessorFn: (r) => roleLabel(t, r.key, r.name),
        cell: ({ getValue }) => <span className="font-medium text-foreground">{String(getValue())}</span>,
      },
      {
        id: 'key',
        header: t('roles.columns.key'),
        accessorKey: 'key',
        cell: ({ row }) => <span className="font-mono text-caption">{row.original.key}</span>,
      },
      {
        id: 'permissions',
        header: t('roles.columns.permissions'),
        enableSorting: false,
        cell: ({ row }) => <PermissionList permissions={row.original.permissions} />,
      },
      {
        id: 'type',
        header: t('roles.columns.type'),
        accessorFn: (r) => (r.is_system ? 0 : 1),
        cell: ({ row }) =>
          row.original.is_system ? (
            <Badge tone="neutral">{t('roles.system')}</Badge>
          ) : (
            <Badge tone="primary">{t('roles.custom')}</Badge>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          canManage && !row.original.is_system ? (
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing({ role: row.original })}>
                {t('roles.edit')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(row.original)}>
                {t('roles.delete')}
              </Button>
            </div>
          ) : null,
      },
    ],
    [t, canManage],
  );

  return (
    <>
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={
          canManage ? (
            <Button onClick={() => setEditing({ role: null })}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('roles.create')}
            </Button>
          ) : null
        }
      />
      <QueryState query={roles}>
        <DataTable
          columns={columns}
          data={roles.data ?? []}
          emptyState={<EmptyState title={t('roles.empty')} />}
        />
      </QueryState>
      {canManage && (
        <RoleDialog
          key={editing?.role?.id ?? 'new'}
          open={editing !== null}
          role={editing?.role ?? null}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('roles.deleteTitle')}
        description={deleting ? t('roles.deleteBody', { name: roleLabel(t, deleting.key, deleting.name) }) : undefined}
        confirmLabel={t('roles.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  );
}
