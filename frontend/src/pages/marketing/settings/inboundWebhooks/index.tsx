import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Webhook, Clipboard, Trash2, KeyRound, Check } from 'lucide-react';
import {
  listInboundWebhooks,
  createInboundWebhook,
  updateInboundWebhook,
  rotateInboundWebhookSecret,
  deleteInboundWebhook,
  type InboundWebhook,
  type InboundWebhookWithSecret,
} from '../../../../features/marketing/api/inbound-webhooks.service';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Callout } from '@/components/ui/Callout';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the value is still selectable */
    }
  };
  return (
    <div>
      <div className="text-caption text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-surface-muted rounded px-2 py-1.5 break-all">{value}</code>
        <IconButton variant="ghost" size="sm" aria-label="Copy" onClick={copy}>
          {copied ? <Check className="h-4 w-4 text-success" /> : <Clipboard className="h-4 w-4" />}
        </IconButton>
      </div>
    </div>
  );
}

export default function InboundWebhooksPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<InboundWebhookWithSecret | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InboundWebhook | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const { data: hooks, isLoading } = useQuery<InboundWebhook[]>({
    queryKey: ['marketing', 'inbound-webhooks'],
    queryFn: listInboundWebhooks,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['marketing', 'inbound-webhooks'] });

  const create = useMutation({
    mutationFn: () => createInboundWebhook(name.trim()),
    onSuccess: (w) => {
      invalidate();
      setCreateOpen(false);
      setName('');
      setRevealed(w); // show the secret + URL exactly once
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('inboundWebhooks.createFailed', 'Could not create webhook')),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateInboundWebhook(id, { enabled }),
    onSuccess: invalidate,
  });

  const rotate = useMutation({
    mutationFn: (id: string) => rotateInboundWebhookSecret(id),
    onSuccess: (w) => {
      invalidate();
      setRevealed(w);
      toast.success(t('inboundWebhooks.rotated', 'Secret rotated — the old one no longer works'));
    },
    onSettled: () => setRotatingId(null),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteInboundWebhook(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('inboundWebhooks.title', 'Inbound webhooks')}
        description={t(
          'inboundWebhooks.subtitle',
          'Give an external system a URL to POST JSON to — each call can start a workflow (trigger: webhook.received).',
        )}
        actions={
          <Button onClick={() => { setName(''); setCreateOpen(true); }} size="md">
            <Plus className="h-4 w-4" />
            {t('inboundWebhooks.new', 'New webhook')}
          </Button>
        }
      />

      {/* ── Create dialog ───────────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('inboundWebhooks.new', 'New webhook')}</DialogTitle>
            <DialogDescription>
              {t('inboundWebhooks.createHint', 'Name it for the system that will call it (e.g. “Typeform”, “Zapier”).')}
            </DialogDescription>
          </DialogHeader>
          <Field label={t('inboundWebhooks.name', 'Name')} required>
            {({ id }) => (
              <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || create.isPending}>
              {t('common.create', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Secret reveal (shown once) ──────────────────────────────────── */}
      <Dialog open={!!revealed} onOpenChange={(o) => { if (!o) setRevealed(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('inboundWebhooks.readyTitle', 'Webhook ready')}</DialogTitle>
            <DialogDescription>
              {t('inboundWebhooks.readyHint', 'Copy the secret now — it is shown only once. POST JSON to the URL with the secret in the x-webhook-secret header.')}
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="space-y-3">
              <CopyRow label={t('inboundWebhooks.url', 'POST URL')} value={revealed.url} />
              <CopyRow label={t('inboundWebhooks.secret', 'Secret (x-webhook-secret)')} value={revealed.secret} />
              <Callout tone="warning">
                {t('inboundWebhooks.secretWarn', 'Store this secret securely. If you lose it, rotate to get a new one.')}
              </Callout>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>{t('common.done', 'Done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ──────────────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('inboundWebhooks.deleteTitle', 'Delete webhook?')}
        description={t('inboundWebhooks.deleteDesc', 'The URL stops accepting calls immediately. Workflows already started are unaffected.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      {/* ── List ────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {(hooks ?? []).map((w) => (
          <Card key={w.id}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Webhook className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
                    <span className="font-medium text-foreground truncate">{w.name}</span>
                    <Badge tone={w.enabled ? 'success' : 'neutral'} size="sm">
                      {w.enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
                    </Badge>
                  </div>
                  <div className="mt-2 max-w-xl">
                    <CopyRow label={t('inboundWebhooks.url', 'POST URL')} value={w.url} />
                  </div>
                  <p className="text-caption text-muted-foreground mt-2">
                    {t('inboundWebhooks.received', 'Received')}: {w.receivedCount}
                    {w.lastReceivedAt ? ` · ${t('inboundWebhooks.last', 'last')} ${fmtDateTime(w.lastReceivedAt)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    checked={w.enabled}
                    onCheckedChange={(enabled) => toggle.mutate({ id: w.id, enabled })}
                    aria-label={t('inboundWebhooks.toggle', 'Enable/disable')}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setRotatingId(w.id); rotate.mutate(w.id); }}
                    loading={rotate.isPending && rotatingId === w.id}
                    disabled={rotate.isPending}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    {t('inboundWebhooks.rotate', 'Rotate secret')}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('common.delete', 'Delete')}
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(w)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {!isLoading && (hooks ?? []).length === 0 && (
          <EmptyState
            icon={<Webhook className="h-10 w-10" />}
            title={t('inboundWebhooks.emptyTitle', 'No inbound webhooks yet')}
            description={t('inboundWebhooks.empty', 'Create one to let an external system start workflows by POSTing JSON.')}
            action={
              <Button onClick={() => { setName(''); setCreateOpen(true); }}>
                <Plus className="h-4 w-4" />
                {t('inboundWebhooks.new', 'New webhook')}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
