import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Webhook, Clipboard, Trash2, Pencil, Send, ListChecks } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
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
import {
  WebhookFormDialog,
  type WebhookFormValues,
  type WebhookEndpoint,
} from './WebhookFormDialog';
import { WebhookDeliveriesDialog } from './WebhookDeliveriesDialog';

/** createEndpoint() additionally returns the `whsec_` secret exactly once. */
interface CreatedWebhook {
  id: string;
  url: string;
  events: string[];
  status: string;
  secret: string;
}

export default function WebhooksPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [mintedSecret, setMintedSecret] = useState<CreatedWebhook | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookEndpoint | null>(null);

  const { data, isLoading } = useQuery<WebhookEndpoint[]>({
    queryKey: ['marketing', 'webhooks'],
    queryFn: () => marketingApi.get('/webhooks').then((r) => r.data),
  });

  const endpoints: WebhookEndpoint[] = Array.isArray(data) ? data : [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'webhooks'] });

  const createMutation = useMutation({
    mutationFn: (values: WebhookFormValues) =>
      marketingApi
        .post('/webhooks', {
          url: values.url,
          events: values.events,
          description: values.description || undefined,
        })
        .then((r) => r.data as CreatedWebhook),
    onSuccess: (created) => {
      invalidate();
      setFormOpen(false);
      setMintedSecret(created);
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('webhooks.createFailed', { defaultValue: 'Failed to add endpoint' }),
      ),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: WebhookFormValues }) =>
      marketingApi.patch(`/webhooks/${id}`, {
        url: values.url,
        events: values.events,
        description: values.description || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('webhooks.updateSuccess', { defaultValue: 'Endpoint updated' }));
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('webhooks.updateFailed', { defaultValue: 'Failed to update endpoint' }),
      ),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'DISABLED' }) =>
      marketingApi.patch(`/webhooks/${id}`, { status }),
    onSuccess: () => invalidate(),
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('webhooks.statusFailed', { defaultValue: 'Failed to change status' }),
      ),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/webhooks/${id}/test`),
    onSuccess: () =>
      toast.success(t('webhooks.testQueued', { defaultValue: 'Test event queued' })),
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('webhooks.testFailed', { defaultValue: 'Failed to queue test' }),
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/webhooks/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('webhooks.deleteSuccess', { defaultValue: 'Endpoint deleted' }));
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('webhooks.deleteFailed', { defaultValue: 'Failed to delete endpoint' }),
      ),
  });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (ep: WebhookEndpoint) => {
    setEditing(ep);
    setFormOpen(true);
  };
  const handleFormClose = (open: boolean) => {
    setFormOpen(open);
    if (!open) setEditing(null);
  };
  const handleSubmit = (values: WebhookFormValues) => {
    if (editing) updateMutation.mutate({ id: editing.id, values });
    else createMutation.mutate(values);
  };

  const copy = (value: string) => {
    navigator.clipboard.writeText(value);
    toast.success(t('common.copied', { defaultValue: 'Copied' }));
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('webhooks.title', { defaultValue: 'Webhooks' })}
        description={t('webhooks.subtitle', {
          defaultValue:
            'Stream workspace events to your own URLs. Each delivery is signed with the endpoint secret so you can verify it came from us.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('webhooks.createButton', { defaultValue: 'Add endpoint' })}
          </Button>
        }
      />

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : endpoints.length === 0 ? (
        <EmptyState
          icon={<Webhook className="h-10 w-10" />}
          title={t('webhooks.empty', { defaultValue: 'No endpoints yet' })}
          description={t('webhooks.emptyHint', {
            defaultValue: 'Add an endpoint to start receiving signed event deliveries.',
          })}
          action={
            <Button onClick={openCreate} variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('webhooks.createButton', { defaultValue: 'Add endpoint' })}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep) => {
            const active = ep.status === 'ACTIVE';
            return (
              <Card key={ep.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <Webhook className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium text-foreground">{ep.url}</span>
                          <Badge tone={active ? 'success' : 'neutral'} size="sm">
                            {t(`webhooks.status.${ep.status}`, {
                              defaultValue: active ? 'Active' : 'Disabled',
                            })}
                          </Badge>
                          {(ep.failureCount ?? 0) > 0 && (
                            <Badge tone="warning" size="sm">
                              {t('webhooks.failures', {
                                defaultValue: '{{count}} failure(s)',
                                count: ep.failureCount,
                              })}
                            </Badge>
                          )}
                        </div>
                        {ep.description && (
                          <p className="mt-0.5 text-caption text-muted-foreground">{ep.description}</p>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {(ep.events ?? []).length === 0 ? (
                            <Badge tone="info" size="sm">
                              {t('webhooks.allEvents', { defaultValue: 'all events' })}
                            </Badge>
                          ) : (
                            (ep.events ?? []).map((evt) => (
                              <Badge key={evt} tone="neutral" size="sm" className="font-mono">
                                {evt}
                              </Badge>
                            ))
                          )}
                        </div>
                        {ep.lastDeliveryAt && (
                          <p className="mt-1.5 text-micro text-muted-foreground">
                            {t('webhooks.lastDelivery', { defaultValue: 'Last delivery' })}:{' '}
                            {fmtDateTime(ep.lastDeliveryAt)}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <div className="flex items-center gap-1.5 pe-1">
                        <Switch
                          aria-label={t('webhooks.toggle', { defaultValue: 'Enable endpoint' })}
                          checked={active}
                          disabled={statusMutation.isPending}
                          onCheckedChange={(checked) =>
                            statusMutation.mutate({
                              id: ep.id,
                              status: checked ? 'ACTIVE' : 'DISABLED',
                            })
                          }
                        />
                      </div>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('webhooks.viewDeliveries', { defaultValue: 'View deliveries' })}
                        onClick={() => setDeliveriesFor(ep)}
                      >
                        <ListChecks className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('webhooks.sendTest', { defaultValue: 'Send test' })}
                        disabled={testMutation.isPending}
                        onClick={() => testMutation.mutate(ep.id)}
                      >
                        <Send className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('common.edit', { defaultValue: 'Edit' })}
                        onClick={() => openEdit(ep)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('common.delete', { defaultValue: 'Delete' })}
                        className="text-danger hover:bg-danger-subtle"
                        onClick={() => setDeleteTarget(ep)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      <WebhookFormDialog
        open={formOpen}
        onOpenChange={handleFormClose}
        endpoint={editing}
        onSubmit={handleSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      {/* Show-once signing secret */}
      <Dialog
        open={!!mintedSecret}
        onOpenChange={(open) => { if (!open) setMintedSecret(null); }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('webhooks.createdTitle', { defaultValue: 'Endpoint created' })}
            </DialogTitle>
            <DialogDescription>
              {t('webhooks.createdHint', {
                defaultValue:
                  'Use this signing secret to verify the x-webhook-signature header. It will never be shown again.',
              })}
            </DialogDescription>
          </DialogHeader>

          {mintedSecret && (
            <Callout
              tone="warning"
              title={t('webhooks.copyOnce', {
                defaultValue: 'This is the only time you will see this secret.',
              })}
            >
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded border border-border bg-surface px-2 py-1.5 text-xs">
                  {mintedSecret.secret}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('common.copy', { defaultValue: 'Copy' })}
                  onClick={() => copy(mintedSecret.secret)}
                >
                  <Clipboard className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Callout>
          )}

          <DialogFooter>
            <Button onClick={() => setMintedSecret(null)}>
              {t('common.done', { defaultValue: 'Done' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deliveries dialog */}
      <WebhookDeliveriesDialog
        endpoint={deliveriesFor}
        onOpenChange={(open) => { if (!open) setDeliveriesFor(null); }}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('webhooks.deleteTitle', { defaultValue: 'Delete endpoint?' })}
        description={t('webhooks.deleteDesc', {
          defaultValue: 'Events will no longer be delivered to this URL. This cannot be undone.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
    </div>
  );
}
