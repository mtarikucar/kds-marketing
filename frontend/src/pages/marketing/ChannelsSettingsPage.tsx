import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MessageSquare,
  Trash2,
  Clipboard,
  BadgeCheck,
} from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { startTiktokAdsOAuth } from '../../features/marketing/api/ads.service';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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

// ── Channel status badge ──────────────────────────────────────────────────────

function statusTone(status: string) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'INACTIVE') return 'neutral' as const;
  return 'neutral' as const;
}

// ── Main page ────────────────────────────────────────────────────────────────
// This page MANAGES existing channels (answering agent / verify / delete /
// embed & callback URLs). Connecting a new channel now lives in the unified
// Account Center (/accounts) — the single place to wire up company integrations.

export default function ChannelsSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
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

  // ── Mutations ─────────────────────────────────────────────────────────────
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

  // Answering-agent picker (which AI answers on this channel) — the one piece of
  // "setup" that stays here since it's ongoing management, not connecting.
  const setAgent = useMutation({
    mutationFn: ({ id, agentProfileId }: { id: string; agentProfileId: string | null }) =>
      marketingApi.patch(`/channels/${id}`, { agentProfileId }),
    onSuccess: () => invalidate(),
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? t('channels.agentSaveFailed', 'Could not update the answering agent'),
      ),
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const embedSnippet = (widgetKey: string) =>
    `<script src="${window.location.origin}/widget.js" data-widget-key="${widgetKey}" async></script>`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('channels.title', 'Channels')}
        description={t(
          'channels.subtitle',
          'Manage the channels your customers message you on — pick which AI agent answers, verify credentials, and grab embed & webhook URLs. Connect new channels in the Account Center.',
        )}
        actions={
          <Button asChild variant="outline" size="md">
            <Link to="/accounts">
              {t('channels.connectInAccountCenter', 'Connect a channel in the Account Center')}
            </Link>
          </Button>
        }
      />

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

              {/* Answering agent — which AI (if any) auto-replies on this channel. */}
              <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-2">
                <span className="text-caption text-muted-foreground">
                  {t('channels.agent', 'Answering agent')}
                </span>
                <Select
                  value={c.agentProfileId ?? '__none__'}
                  onValueChange={(v) =>
                    setAgent.mutate({
                      id: c.id,
                      agentProfileId: v === '__none__' ? null : v,
                    })
                  }
                >
                  <SelectTrigger className="w-64 max-w-full">
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
              'No channels yet — connect one in the Account Center so customers can message you.',
            )}
            action={
              <Button asChild variant="outline">
                <Link to="/accounts">
                  {t('channels.connectInAccountCenter', 'Connect a channel in the Account Center')}
                </Link>
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
