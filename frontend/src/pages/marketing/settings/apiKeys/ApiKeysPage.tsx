import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, KeyRound, Clipboard, Trash2 } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import { copyToClipboard } from '../../../../lib/clipboard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Callout } from '@/components/ui/Callout';
import { CreateApiKeyDialog, type ApiKeyFormValues } from './CreateApiKeyDialog';

// ── Types (mirror api-keys.service response shapes) ──────────────────────────

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt?: string | null;
  createdAt: string;
  revokedAt?: string | null;
}

/** create() additionally returns the raw `key` exactly once. */
interface CreatedApiKey extends Omit<ApiKeyRow, 'lastUsedAt' | 'revokedAt'> {
  key: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ApiKeysPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [mintedKey, setMintedKey] = useState<CreatedApiKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const { data, isLoading } = useQuery<ApiKeyRow[]>({
    queryKey: ['marketing', 'api-keys'],
    queryFn: () => marketingApi.get('/api-keys').then((r) => r.data),
  });

  const keys: ApiKeyRow[] = Array.isArray(data) ? data : [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'api-keys'] });

  const createMutation = useMutation({
    mutationFn: (values: ApiKeyFormValues) =>
      marketingApi
        .post('/api-keys', { name: values.name, scopes: values.scopes })
        .then((r) => r.data as CreatedApiKey),
    onSuccess: (created) => {
      invalidate();
      setCreateOpen(false);
      setMintedKey(created);
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('apiKeys.createFailed', { defaultValue: 'Failed to create API key' }),
      ),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/api-keys/${id}`),
    onSuccess: () => {
      invalidate();
      setRevokeTarget(null);
      toast.success(t('apiKeys.revokeSuccess', { defaultValue: 'API key revoked' }));
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('apiKeys.revokeFailed', { defaultValue: 'Failed to revoke API key' }),
      ),
  });

  // Report the REAL copy outcome — a false "Copied" on the show-once API key
  // would lose it (it is never shown again).
  const copy = async (value: string) => {
    if (await copyToClipboard(value)) {
      toast.success(t('common.copied', { defaultValue: 'Copied' }));
    } else {
      toast.error(
        t('common.copyFailed', {
          defaultValue: 'Could not copy — select the key and copy it manually.',
        }),
      );
    }
  };

  // ── Columns ────────────────────────────────────────────────────────────────

  const columns: ColumnDef<ApiKeyRow, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('apiKeys.table.name', { defaultValue: 'Name' }),
      cell: ({ row }) => {
        const k = row.original;
        return (
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{k.name}</p>
            <code className="text-micro text-muted-foreground">{k.prefix}…</code>
          </div>
        );
      },
    },
    {
      accessorKey: 'scopes',
      header: t('apiKeys.table.scopes', { defaultValue: 'Scopes' }),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {(row.original.scopes ?? []).map((s) => (
            <Badge key={s} tone="neutral" size="sm" className="uppercase">
              {s}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: t('apiKeys.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={val === 'ACTIVE' ? 'success' : 'neutral'} size="sm">
            {t(`apiKeys.status.${val}`, {
              defaultValue: val === 'ACTIVE' ? 'Active' : 'Revoked',
            })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'lastUsedAt',
      header: t('apiKeys.table.lastUsed', { defaultValue: 'Last used' }),
      cell: ({ getValue }) => {
        const val = getValue<string | null | undefined>();
        return (
          <span className="text-sm text-muted-foreground">
            {val ? fmtDateTime(val) : t('apiKeys.neverUsed', { defaultValue: 'Never' })}
          </span>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: t('apiKeys.table.created', { defaultValue: 'Created' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">
          {fmtDateTime(getValue<string>())}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 96,
      cell: ({ row }) => {
        const k = row.original;
        if (k.status !== 'ACTIVE') {
          return (
            <span className="text-xs text-muted-foreground">
              {t('apiKeys.status.REVOKED', { defaultValue: 'Revoked' })}
            </span>
          );
        }
        return (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-subtle"
            onClick={() => setRevokeTarget(k)}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t('apiKeys.revoke', { defaultValue: 'Revoke' })}
          </Button>
        );
      },
    },
  ];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('apiKeys.title', { defaultValue: 'API keys' })}
        description={t('apiKeys.subtitle', {
          defaultValue:
            'Programmatic keys that grant external integrations access to this workspace. Treat them like passwords.',
        })}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('apiKeys.createButton', { defaultValue: 'Create key' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={keys}
        isLoading={isLoading}
        loadingRowCount={5}
        emptyState={
          <EmptyState
            icon={<KeyRound className="h-10 w-10" />}
            title={t('apiKeys.empty', { defaultValue: 'No API keys yet' })}
            description={t('apiKeys.emptyHint', {
              defaultValue: 'Create a key to let an external integration call the workspace API.',
            })}
            action={
              <Button onClick={() => setCreateOpen(true)} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('apiKeys.createButton', { defaultValue: 'Create key' })}
              </Button>
            }
          />
        }
      />

      {/* Create dialog */}
      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(values) => createMutation.mutate(values)}
        isPending={createMutation.isPending}
      />

      {/* Show-once raw key dialog */}
      <Dialog
        open={!!mintedKey}
        onOpenChange={(open) => { if (!open) setMintedKey(null); }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('apiKeys.createdTitle', { defaultValue: 'API key created' })}</DialogTitle>
            <DialogDescription>
              {t('apiKeys.createdHint', {
                defaultValue: 'Copy this key now — for your security it will never be shown again.',
              })}
            </DialogDescription>
          </DialogHeader>

          {mintedKey && (
            <Callout
              tone="warning"
              title={t('apiKeys.copyOnce', {
                defaultValue: 'This is the only time you will see this key.',
              })}
            >
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded border border-border bg-surface px-2 py-1.5 text-xs">
                  {mintedKey.key}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('common.copy', { defaultValue: 'Copy' })}
                  onClick={() => copy(mintedKey.key)}
                >
                  <Clipboard className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Callout>
          )}

          <DialogFooter>
            <Button onClick={() => setMintedKey(null)}>
              {t('common.done', { defaultValue: 'Done' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title={t('apiKeys.revokeTitle', { defaultValue: 'Revoke API key?' })}
        description={t('apiKeys.revokeDesc', {
          defaultValue:
            'Any integration using this key will immediately lose access. This cannot be undone.',
        })}
        confirmLabel={t('apiKeys.revoke', { defaultValue: 'Revoke' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={revokeMutation.isPending}
        onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
      />
    </div>
  );
}
