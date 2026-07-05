import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MessageSquare,
  Trash2,
  BadgeCheck,
} from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
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

export default function ChannelsSettingsPage({ embedded }: { embedded?: boolean } = {}) {
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

  return (
    <div className="space-y-6">
      {!embedded && (
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
      )}

      {/* Embedded (Inbox tab): the header is the host's, so the connect CTA
          moves into a small toolbar row — the action must never be lost. */}
      {embedded && (channels ?? []).length > 0 && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="md">
            <Link to="/accounts">
              {t('channels.connectInAccountCenter', 'Connect a channel in the Account Center')}
            </Link>
          </Button>
        </div>
      )}

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

              {/* Connection setup URLs (Meta webhook / NetGSM inbound / web-chat
                  embed) moved to the Account Center — they're part of connecting,
                  not managing. This page keeps agent assignment + verify + delete. */}

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
