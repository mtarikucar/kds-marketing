import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MessageSquare,
  Trash2,
  Clipboard,
  BadgeCheck,
  Plus,
  Facebook,
} from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { startTiktokAdsOAuth } from '../../features/marketing/api/ads.service';
import { WhatsappSignupButton } from './WhatsappSignupButton';
import { useSocialConnect } from './social/useSocialConnect';
import { AccountSelectDialog } from './social/AccountSelectDialog';
import {
  CHANNEL_TYPES,
  SECRET_FIELDS,
  NEEDS_EXTERNAL_ID,
  type ChannelType,
} from './channels/channelFields';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  status: string;
  agentProfileId?: string | null;
  widgetKey?: string | null;
  externalId?: string | null;
  configuredSecrets: string[];
  lastVerifiedAt?: string | null;
  // SMS (NetGSM) only: tokenized inbound-MO callback URL to paste into the NetGSM
  // panel. Null until the server has PUBLIC_BASE_URL + MARKETING_SECRET_KEY set.
  callbackUrl?: string | null;
  // Meta (WhatsApp/Messenger/Instagram) only: the static signed webhook URL to
  // paste into the Meta App dashboard, + whether the verify-token env is set.
  webhookUrl?: string | null;
  verifyTokenConfigured?: boolean;
  // LinkedIn engagement only: mask() echoes configPublic so the card can show
  // whether Community Management access has been granted (the capability flag).
  configPublic?: Record<string, unknown> | null;
  // TIKTOK only: whether messaging scope was granted via OAuth.
  messaging?: boolean | null;
}
interface AgentRow {
  id: string;
  name: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Channel-type field metadata (CHANNEL_TYPES / SECRET_FIELDS / NEEDS_EXTERNAL_ID)
// now lives in ./channels/channelFields so the Account Center's inline setup
// shares the exact same definitions — imported above.

// ── Schema ───────────────────────────────────────────────────────────────────

const channelSchema = z.object({
  type: z.enum(CHANNEL_TYPES),
  name: z.string().min(1).max(120),
  agentProfileId: z.string().optional(),
  externalId: z.string().optional(),
  secrets: z.record(z.string()).optional(),
});
type ChannelFormValues = z.infer<typeof channelSchema>;

// ── Channel status badge ──────────────────────────────────────────────────────

function statusTone(status: string) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'INACTIVE') return 'neutral' as const;
  return 'neutral' as const;
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ChannelsSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChannelRow | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: channels } = useQuery<ChannelRow[]>({
    queryKey: ['marketing', 'channels'],
    queryFn: () => marketingApi.get('/channels').then((r) => r.data),
  });
  const { data: agents } = useQuery<AgentRow[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'channels'] });

  // ── OAuth connect (Messenger + Instagram DM via the shared Meta grant) ──────
  // Reuses the Social Planner's Meta OAuth: one Facebook grant enumerates the
  // user's Pages + linked IG business accounts, and the pick dialog turns the
  // chosen ones into messaging Channels (and Social publishing accounts). Gated
  // on the platform Meta app being configured (same status the Social page uses).
  const { startConnect } = useSocialConnect();
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  const { data: socialStatus } = useQuery<Record<string, boolean>>({
    queryKey: ['marketing', 'social', 'status'],
    queryFn: () => marketingApi.get('/social-planner/status').then((r) => r.data),
  });
  const fbConnectable = !!socialStatus?.FACEBOOK;

  // The OAuth callback returns to /channels?connect=<pendingId> (success) or
  // ?connect_error=1 (failure). Pick it up once, open the account picker, strip it.
  useEffect(() => {
    const connectId = searchParams.get('connect');
    const connectErr = searchParams.get('connect_error');
    if (connectId) {
      setPendingConnectId(connectId);
      searchParams.delete('connect');
      setSearchParams(searchParams, { replace: true });
    } else if (connectErr) {
      toast.error(
        t('social.oauth.callbackError', {
          defaultValue: 'Connection failed or was cancelled. Please try again.',
        }),
      );
      searchParams.delete('connect_error');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Form ─────────────────────────────────────────────────────────────────
  const form = useForm<ChannelFormValues>({
    resolver: zodResolver(channelSchema),
    defaultValues: { type: 'WEBCHAT', name: '', agentProfileId: '', externalId: '', secrets: {} },
  });
  const selectedType = useWatch({ control: form.control, name: 'type' }) as ChannelType;

  const openForm = () => {
    form.reset({ type: 'WEBCHAT', name: '', agentProfileId: '', externalId: '', secrets: {} });
    setFormOpen(true);
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const create = useMutation({
    mutationFn: (values: ChannelFormValues) =>
      marketingApi.post('/channels', {
        type: values.type,
        name: values.name,
        agentProfileId: values.agentProfileId || undefined,
        externalId: values.externalId || undefined,
        secrets:
          values.secrets && Object.keys(values.secrets).length ? values.secrets : undefined,
      }),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast.success(t('channels.saved', 'Channel saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('channels.saveFailed', 'Save failed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/channels/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('channels.deleteFailed', 'Could not delete the channel')),
  });

  const verify = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/channels/${id}/verify`),
    onSuccess: ({ data }) => {
      invalidate();
      toast[data?.ok ? 'success' : 'error'](
        data?.ok
          ? t('channels.verifyOk', 'Channel verified ✓')
          : t('channels.verifyFail', 'Verification failed — check credentials'),
      );
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('channels.verifyFail', 'Verification failed — check credentials')),
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const embedSnippet = (widgetKey: string) =>
    `<script src="${window.location.origin}/widget.js" data-widget-key="${widgetKey}" async></script>`;

  const secretFields = SECRET_FIELDS[selectedType] ?? [];
  const externalIdLabel = NEEDS_EXTERNAL_ID[selectedType];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('channels.title', 'Channels')}
        description={t(
          'channels.subtitle',
          'Connect where your customers message you — web chat, WhatsApp, SMS, Instagram, Messenger. Pick which AI agent answers on each.',
        )}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="md"
              disabled={!fbConnectable}
              title={
                fbConnectable
                  ? undefined
                  : t('channels.metaConnectHint', {
                      defaultValue: 'An admin must add the Meta (Facebook) app credentials first',
                    })
              }
              onClick={() => startConnect('FACEBOOK', { origin: 'channels' })}
            >
              <Facebook className="h-4 w-4" />
              {t('channels.metaConnect', 'Connect Messenger & Instagram')}
            </Button>
            <WhatsappSignupButton />
            <Button onClick={openForm} size="md">
              <Plus className="h-4 w-4" />
              {t('channels.new', 'Connect a channel')}
            </Button>
          </div>
        }
      />

      {/* Post-OAuth account picker: turns the granted Pages / IG accounts into
          messaging Channels (messaging pre-checked since we came from here). */}
      <AccountSelectDialog
        context="channels"
        pendingId={pendingConnectId}
        onOpenChange={(open) => {
          if (!open) setPendingConnectId(null);
        }}
        onConnected={invalidate}
      />

      {/* ── Create dialog ─────────────────────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('channels.new', 'Connect a channel')}</DialogTitle>
            <DialogDescription>
              {t('channels.formHint', 'Fill in the credentials your provider requires.')}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={form.handleSubmit((v) => create.mutate(v))}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Type */}
              <Field label={t('channels.type', 'Type')}>
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(v) => {
                          field.onChange(v);
                          form.setValue('secrets', {});
                          form.setValue('externalId', '');
                        }}
                      >
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CHANNEL_TYPES.map((ty) => (
                            <SelectItem key={ty} value={ty}>
                              {ty}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>

              {/* Name */}
              <Field
                label={t('channels.name', 'Name')}
                error={form.formState.errors.name?.message}
                required
              >
                {({ id, invalid }) => (
                  <Input
                    id={id}
                    aria-invalid={invalid}
                    placeholder="Support line"
                    maxLength={120}
                    {...form.register('name')}
                  />
                )}
              </Field>

              {/* Answering agent */}
              <Field label={t('channels.agent', 'Answering agent')}>
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="agentProfileId"
                    render={({ field }) => (
                      <Select
                        value={field.value || '__none__'}
                        onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)}
                      >
                        <SelectTrigger id={id}>
                          <SelectValue
                            placeholder={t('channels.noAgent', '— none (manual only) —')}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            {t('channels.noAgent', '— none (manual only) —')}
                          </SelectItem>
                          {(agents ?? []).map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            </div>

            {/* External ID */}
            {externalIdLabel && (
              <Field label={externalIdLabel}>
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder={externalIdLabel}
                    {...form.register('externalId')}
                  />
                )}
              </Field>
            )}

            {/* Secret fields */}
            {secretFields.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {secretFields.map((key) => (
                  <Field key={key} label={key}>
                    {({ id }) => (
                      <Input
                        id={id}
                        type="password"
                        placeholder="••••••••"
                        autoComplete="off"
                        {...form.register(`secrets.${key}`)}
                      />
                    )}
                  </Field>
                ))}
              </div>
            )}

            {selectedType === 'WEBCHAT' && (
              <p className="text-caption text-muted-foreground">
                {t(
                  'channels.webchatHint',
                  'No credentials needed — a public embed snippet is generated after you save.',
                )}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormOpen(false)}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" loading={create.isPending} disabled={create.isPending}>
                {t('common.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('channels.deleteTitle', 'Delete channel?')}
        description={t(
          'channels.deleteDesc',
          'This disconnects the channel immediately. Messages in flight may fail.',
        )}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      {/* ── Channel list ──────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {(channels ?? []).map((c) => (
          <Card key={c.id}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <MessageSquare className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{c.name}</span>
                      <Badge tone="neutral" size="sm" className="uppercase">
                        {c.type}
                      </Badge>
                      <Badge tone={statusTone(c.status)} size="sm">
                        {c.status}
                      </Badge>
                      {c.lastVerifiedAt && (
                        <BadgeCheck
                          className="h-4 w-4 text-success"
                          aria-label={t('channels.verified', 'Verified')}
                        />
                      )}
                    </div>
                    <p className="text-caption text-muted-foreground mt-0.5">
                      {c.configuredSecrets.length > 0
                        ? `${t('channels.secretsSet', 'credentials set')}: ${c.configuredSecrets.join(', ')}`
                        : c.type === 'WEBCHAT'
                          ? t('channels.public', 'public web chat')
                          : t('channels.noSecrets', 'no credentials yet')}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => verify.mutate(c.id)}
                    loading={verify.isPending}
                  >
                    {t('channels.verify', 'Verify')}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('channels.delete', 'Delete channel')}
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(c)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>

              {c.type === 'WEBCHAT' && c.widgetKey && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-caption text-muted-foreground mb-1">
                    {t('channels.embed', 'Embed snippet (paste before </body>)')}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="text-caption bg-surface-muted border border-border rounded px-2 py-1.5 flex-1 break-all">
                      {embedSnippet(c.widgetKey)}
                    </code>
                    <IconButton
                      variant="outline"
                      size="sm"
                      aria-label={t('common.copy', 'Copy')}
                      onClick={() => {
                        navigator.clipboard.writeText(embedSnippet(c.widgetKey!));
                        toast.success(t('common.copied', 'Copied'));
                      }}
                    >
                      <Clipboard className="h-4 w-4" />
                    </IconButton>
                  </div>
                </div>
              )}

              {/* NetGSM inbound (MO) callback URL — paste into the panel so customer
                  replies reach this channel. Surfaced like the web-chat snippet. */}
              {c.type === 'SMS' && c.callbackUrl && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-caption text-muted-foreground mb-1">
                    {t(
                      'channels.netgsmCallback',
                      'NetGSM inbound (MO) URL — paste into İnteraktif SMS → “URL Adresine Yönlendir”',
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="text-caption bg-surface-muted border border-border rounded px-2 py-1.5 flex-1 break-all">
                      {c.callbackUrl}
                    </code>
                    <IconButton
                      variant="outline"
                      size="sm"
                      aria-label={t('common.copy', 'Copy')}
                      onClick={() => {
                        navigator.clipboard.writeText(c.callbackUrl!);
                        toast.success(t('common.copied', 'Copied'));
                      }}
                    >
                      <Clipboard className="h-4 w-4" />
                    </IconButton>
                  </div>
                </div>
              )}
              {c.type === 'SMS' && !c.callbackUrl && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-caption text-muted-foreground">
                    {t(
                      'channels.netgsmCallbackPending',
                      'Inbound (MO) reply URL appears here once the server has PUBLIC_BASE_URL and MARKETING_SECRET_KEY set.',
                    )}
                  </p>
                </div>
              )}

              {/* Meta (WhatsApp/Messenger/Instagram) inbound + delivery receipts
                  arrive on ONE static, signed webhook for the whole app. Surface
                  the URL operators paste into the Meta App dashboard. */}
              {['WHATSAPP', 'MESSENGER', 'INSTAGRAM'].includes(c.type) && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-caption text-muted-foreground mb-1">
                    {t(
                      'channels.metaWebhook',
                      'Meta webhook URL — paste into Meta App → Webhooks (one URL for all Meta channels)',
                    )}
                  </p>
                  {c.webhookUrl ? (
                    <div className="flex items-center gap-2">
                      <code className="text-caption bg-surface-muted border border-border rounded px-2 py-1.5 flex-1 break-all">
                        {c.webhookUrl}
                      </code>
                      <IconButton
                        variant="outline"
                        size="sm"
                        aria-label={t('common.copy', 'Copy')}
                        onClick={() => {
                          navigator.clipboard.writeText(c.webhookUrl!);
                          toast.success(t('common.copied', 'Copied'));
                        }}
                      >
                        <Clipboard className="h-4 w-4" />
                      </IconButton>
                    </div>
                  ) : (
                    <p className="text-caption text-muted-foreground">
                      {t(
                        'channels.metaWebhookPending',
                        'Set PUBLIC_BASE_URL on the server to reveal the webhook URL.',
                      )}
                    </p>
                  )}
                  <p className="text-caption text-muted-foreground mt-1">
                    {c.verifyTokenConfigured
                      ? t(
                          'channels.metaVerifyOk',
                          'Verify token is configured — use the META_WEBHOOK_VERIFY_TOKEN value as the Verify Token in Meta.',
                        )
                      : t(
                          'channels.metaVerifyMissing',
                          'Set META_WEBHOOK_VERIFY_TOKEN on the server, then use that value as the Verify Token in Meta.',
                        )}
                  </p>
                </div>
              )}

              {/* LinkedIn engagement (comments on OWNED org posts) is the DM
                  substitute — there is no LinkedIn DM API. It is polling-based and
                  stays DORMANT until LinkedIn Community Management access is granted
                  (capability flag in configPublic.linkedinEngagement). */}
              {c.type === 'LINKEDIN' && (
                <div className="mt-3 pt-3 border-t border-border">
                  {(c.configPublic as any)?.linkedinEngagement === 'granted' ? (
                    <p className="text-caption text-success">
                      {t(
                        'channels.linkedinGranted',
                        'Engagement active — replies to comments on your organization posts are AI-answered. (LinkedIn has no DM API; this is sanctioned engagement on owned posts.)',
                      )}
                    </p>
                  ) : (
                    <p className="text-caption text-muted-foreground">
                      {t(
                        'channels.linkedinPending',
                        'Dormant — comment engagement turns on once LinkedIn Community Management access is approved. LinkedIn exposes no DM API, so this answers comments on your OWN organization posts (polling-based, no webhook).',
                      )}
                    </p>
                  )}
                </div>
              )}

              {/* TikTok DM: webhook URL to paste into the TikTok for Business app
                  dashboard + OAuth shortcut to provision/refresh the DM channel
                  (and ad accounts) in one step. Manual token field remains the
                  fallback for operators who manage tokens directly. */}
              {c.type === 'TIKTOK' && (
                <div className="mt-3 pt-3 border-t border-border space-y-3">
                  {/* Inbound webhook URL */}
                  <div>
                    <p className="text-caption text-muted-foreground mb-1">
                      {t(
                        'channels.tiktokWebhook',
                        'TikTok webhook URL — paste into TikTok for Business App → Webhooks',
                      )}
                    </p>
                    {c.webhookUrl ? (
                      <div className="flex items-center gap-2">
                        <code className="text-caption bg-surface-muted border border-border rounded px-2 py-1.5 flex-1 break-all">
                          {c.webhookUrl}
                        </code>
                        <IconButton
                          variant="outline"
                          size="sm"
                          aria-label={t('common.copy', 'Copy')}
                          onClick={() => {
                            navigator.clipboard.writeText(c.webhookUrl!);
                            toast.success(t('common.copied', 'Copied'));
                          }}
                        >
                          <Clipboard className="h-4 w-4" />
                        </IconButton>
                      </div>
                    ) : (
                      <p className="text-caption text-muted-foreground">
                        {t(
                          'channels.tiktokWebhookPending',
                          'Set PUBLIC_BASE_URL on the server to reveal the webhook URL.',
                        )}
                      </p>
                    )}
                    {c.messaging != null && (
                      <p className="text-caption text-muted-foreground mt-1">
                        {c.messaging
                          ? t('channels.tiktokMessagingOk', 'Messaging scope granted via OAuth.')
                          : t(
                              'channels.tiktokMessagingMissing',
                              'Messaging scope not yet granted — reconnect via "Connect TikTok for Business" below.',
                            )}
                      </p>
                    )}
                  </div>

                  {/* Connect for Business CTA */}
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-caption text-muted-foreground">
                        {t(
                          'channels.tiktokOAuthHint',
                          'Use OAuth to provision this DM channel and ad accounts in one step. The manual token field above remains the fallback.',
                        )}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={async () => {
                        try {
                          const { authorizeUrl } = await startTiktokAdsOAuth();
                          window.location.href = authorizeUrl;
                        } catch {
                          toast.error(
                            t('channels.tiktokOAuthFailed', 'Could not start TikTok OAuth — check server config.'),
                          );
                        }
                      }}
                    >
                      {t('channels.tiktokConnect', 'Connect TikTok for Business')}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {(channels ?? []).length === 0 && (
          <EmptyState
            icon={<MessageSquare className="h-10 w-10" />}
            title={t('channels.emptyTitle', 'No channels yet')}
            description={t(
              'channels.empty',
              'No channels yet — connect one so customers can message you.',
            )}
            action={
              <Button onClick={openForm}>
                <Plus className="h-4 w-4" />
                {t('channels.new', 'Connect a channel')}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
