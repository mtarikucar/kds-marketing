import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, KeyRound } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  ConfirmDialog,
} from '@/components/ui';
import { useSsoConnections, useSsoMutations } from './hooks';
import type { SsoConnection } from './types';
import { SsoFormDialog, type SsoSubmitPayload } from './SsoFormDialog';
import { apiError } from './util';

export function SsoTab() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useSsoConnections();
  const { create, update, remove } = useSsoMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SsoConnection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SsoConnection | null>(null);

  const connections: SsoConnection[] = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (c: SsoConnection) => {
    setEditing(c);
    setFormOpen(true);
  };

  const handleSubmit = (payload: SsoSubmitPayload) => {
    if (editing) {
      // Only send the secret when the operator typed a new one.
      const { clientSecret, ...rest } = payload;
      update.mutate(
        { id: editing.id, data: { ...rest, ...(clientSecret ? { clientSecret } : {}) } },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(null);
            toast.success(t('connections.sso.updated', { defaultValue: 'SSO connection updated' }));
          },
          onError: (e) =>
            toast.error(apiError(e, t('connections.sso.saveError', { defaultValue: 'Failed to save SSO connection' }))),
        },
      );
    } else {
      create.mutate({ ...payload }, {
        onSuccess: () => {
          setFormOpen(false);
          toast.success(t('connections.sso.created', { defaultValue: 'SSO connection created' }));
        },
        onError: (e) =>
          toast.error(apiError(e, t('connections.sso.saveError', { defaultValue: 'Failed to save SSO connection' }))),
      });
    }
  };

  const columns: ColumnDef<SsoConnection, unknown>[] = [
    {
      accessorKey: 'issuer',
      header: t('connections.sso.issuer', { defaultValue: 'Issuer' }),
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div>
            <p className="text-sm font-medium text-foreground">{c.issuer}</p>
            <code className="text-xs text-muted-foreground">{c.clientId}</code>
          </div>
        );
      },
    },
    {
      id: 'secret',
      header: t('connections.sso.clientSecret', { defaultValue: 'Client secret' }),
      cell: ({ row }) =>
        row.original.clientSecretSet ? (
          <Badge tone="success" size="sm">
            {t('connections.sso.secretSet', { defaultValue: 'Set' })}
          </Badge>
        ) : (
          <Badge tone="warning" size="sm">
            {t('connections.sso.secretMissing', { defaultValue: 'Missing' })}
          </Badge>
        ),
    },
    {
      id: 'domains',
      header: t('connections.sso.allowedDomains', { defaultValue: 'Allowed domains' }),
      cell: ({ row }) => {
        const domains = row.original.allowedDomains ?? [];
        if (domains.length === 0)
          return (
            <span className="text-sm text-muted-foreground">
              {t('connections.sso.anyDomain', { defaultValue: 'Any' })}
            </span>
          );
        return (
          <div className="flex flex-wrap gap-1">
            {domains.map((d) => (
              <Badge key={d} tone="neutral" size="sm">
                {d}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      accessorKey: 'enabled',
      header: t('connections.sso.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) =>
        getValue<boolean>() ? (
          <Badge tone="success" size="sm">
            {t('connections.sso.enabled', { defaultValue: 'Enabled' })}
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            {t('connections.sso.disabled', { defaultValue: 'Disabled' })}
          </Badge>
        ),
    },
    {
      id: 'actions',
      header: '',
      size: 96,
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <IconButton
              aria-label={t('common.edit', { defaultValue: 'Edit' })}
              size="sm"
              variant="ghost"
              onClick={() => openEdit(c)}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              aria-label={t('common.delete', { defaultValue: 'Delete' })}
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() => setDeleteTarget(c)}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{t('connections.sso.title', { defaultValue: 'Single sign-on (OIDC)' })}</CardTitle>
          <CardDescription>
            {t('connections.sso.subtitle', {
              defaultValue:
                'Let your team sign in with your identity provider. The client secret is sealed at rest and never displayed.',
            })}
          </CardDescription>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('connections.sso.createTitle', { defaultValue: 'New SSO connection' })}
        </Button>
      </CardHeader>

      <CardContent>
        <DataTable
          columns={columns}
          data={connections}
          isLoading={isLoading}
          loadingRowCount={3}
          emptyState={
            <EmptyState
              icon={<KeyRound className="h-10 w-10" />}
              title={t('connections.sso.empty', { defaultValue: 'No SSO connection yet' })}
              description={t('connections.sso.emptyHint', {
                defaultValue: 'Connect an OpenID Connect provider to enable single sign-on.',
              })}
              action={
                <Button onClick={openCreate} variant="outline">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('connections.sso.createTitle', { defaultValue: 'New SSO connection' })}
                </Button>
              }
            />
          }
        />
      </CardContent>

      <SsoFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        connection={editing}
        onSubmit={handleSubmit}
        isPending={create.isPending || update.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('connections.sso.deleteTitle', { defaultValue: 'Delete SSO connection' })}
        description={t('connections.sso.deleteDesc', {
          defaultValue: 'Your team will no longer be able to sign in via this provider. This cannot be undone.',
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
              toast.success(t('connections.sso.deleted', { defaultValue: 'SSO connection deleted' }));
            },
            onError: (e) => toast.error(apiError(e, t('connections.sso.deleteError', { defaultValue: 'Failed to delete' }))),
          })
        }
      />
    </Card>
  );
}
