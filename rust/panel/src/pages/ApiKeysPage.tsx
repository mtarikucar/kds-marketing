import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createKey, listKeys, revokeKey } from '@/api/apiKeys';
import type { KeyOut, KeySummary, Permission } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { CopyField } from '@/components/CopyField';
import { ErrorCallout } from '@/components/ErrorCallout';
import { PermissionList } from '@/components/PermissionList';
import { PermissionPicker } from '@/components/PermissionPicker';
import { QueryState } from '@/components/QueryState';
import { KeyStatusBadge } from '@/components/StatusBadges';
import {
  Button,
  Callout,
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
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';

const KEYS_KEY = ['api-keys'] as const;

/**
 * Issues a key and shows its plaintext exactly once. The plaintext is held only in this
 * dialog's state (the mutation keeps no cached result) and is dropped when the dialog closes.
 */
function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Permission[]>([]);
  const [created, setCreated] = useState<KeyOut | null>(null);

  const create = useMutation({
    mutationFn: createKey,
    gcTime: 0,
    onSuccess: async (key) => {
      setCreated(key);
      await queryClient.invalidateQueries({ queryKey: KEYS_KEY });
    },
  });

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setScopes([]);
      setCreated(null);
      create.reset();
    }
    onOpenChange(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name: name.trim(), scopes });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? t('apiKeys.dialog.plaintextTitle') : t('apiKeys.dialog.title')}</DialogTitle>
          <DialogDescription>{t('apiKeys.dialog.description')}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning" title={t('apiKeys.dialog.plaintextTitle')}>
              {t('apiKeys.dialog.plaintextWarning')}
            </Callout>
            <CopyField label={t('apiKeys.dialog.plaintextTitle')} value={created.plaintext} />
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('common.done')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <ErrorCallout error={create.error} />
            <Field label={t('fields.name')} required>
              {(ids) => (
                <Input id={ids.id} required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <PermissionPicker
              legend={t('fields.scopes')}
              hint={t('apiKeys.dialog.scopesHint')}
              value={scopes}
              onChange={setScopes}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('apiKeys.dialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const canManage = can(session.data, 'api_keys.manage');
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: listKeys });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<KeySummary | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => revokeKey(id),
    onSuccess: async () => {
      setRevoking(null);
      toast.success(t('apiKeys.revoked'));
      await queryClient.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const columns = useMemo<ColumnDef<KeySummary, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('apiKeys.columns.name'),
        accessorKey: 'name',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.name}</span>,
      },
      {
        id: 'prefix',
        header: t('apiKeys.columns.prefix'),
        accessorKey: 'prefix',
        cell: ({ row }) => <span className="font-mono text-caption">{`${row.original.prefix}…`}</span>,
      },
      {
        id: 'scopes',
        header: t('apiKeys.columns.scopes'),
        enableSorting: false,
        cell: ({ row }) => <PermissionList permissions={row.original.scopes} />,
      },
      {
        id: 'status',
        header: t('apiKeys.columns.status'),
        accessorKey: 'status',
        cell: ({ row }) => <KeyStatusBadge status={row.original.status} />,
      },
      {
        id: 'created',
        header: t('apiKeys.columns.created'),
        accessorKey: 'created_at',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatDateTime(row.original.created_at, i18n.language)}
          </span>
        ),
      },
      {
        id: 'lastUsed',
        header: t('apiKeys.columns.lastUsed'),
        accessorFn: (k) => k.last_used_at ?? '',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {row.original.last_used_at
              ? formatDateTime(row.original.last_used_at, i18n.language)
              : t('apiKeys.neverUsed')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          canManage && row.original.status === 'active' ? (
            <Button variant="ghost" size="sm" onClick={() => setRevoking(row.original)}>
              {t('apiKeys.revoke')}
            </Button>
          ) : null,
      },
    ],
    [t, i18n.language, canManage],
  );

  return (
    <>
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.description')}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('apiKeys.create')}
            </Button>
          ) : null
        }
      />
      <QueryState query={keys}>
        <DataTable
          columns={columns}
          data={keys.data ?? []}
          emptyState={<EmptyState title={t('apiKeys.empty')} description={t('apiKeys.emptyBody')} />}
        />
      </QueryState>
      {canManage && <CreateKeyDialog open={creating} onOpenChange={setCreating} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('apiKeys.revokeTitle')}
        description={revoking ? t('apiKeys.revokeBody', { name: revoking.name }) : undefined}
        confirmLabel={t('apiKeys.revoke')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </>
  );
}
