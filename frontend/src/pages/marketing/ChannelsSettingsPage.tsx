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
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
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

/** POST /channels/:id/verify response — `details` echoes the adapter's
 *  healthCheck (e.g. NetGSM's live /balance probe for SMS): `credsValid` is
 *  `false` for rejected credentials vs `null`/absent when the provider
 *  couldn't be reached at all (transient outage). `headerApproved` (SMS only)
 *  is `false` when the configured NetGSM msgheader is live but not on the
 *  account's İYS-approved sender list — a distinct failure from bad
 *  credentials — with `approvedHeaders` carrying the live list. `message` is
 *  a raw provider diagnostic string (not localized), so it is only ever shown
 *  as secondary detail underneath the i18n headline, never as the headline
 *  itself. */
interface VerifyResponse {
  ok: boolean;
  details?: {
    credsValid?: boolean | null;
    headerApproved?: boolean;
    approvedHeaders?: string[];
    message?: string | null;
    code?: string | null;
    [key: string]: unknown;
  };
}

// ── Channel status badge ──────────────────────────────────────────────────────

function statusTone(status: string) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'INACTIVE') return 'neutral' as const;
  return 'neutral' as const;
}

/** True when the NetGSM MO-poll backup (netgsm-mo-poll.service.ts) stamped a
 *  webhook-miss recovery within the last 48h — signals the push webhook (the
 *  primary inbound path) is likely misconfigured (wrong/missing panel URL) and
 *  silently dropping customer replies. */
const MO_RECOVERY_BADGE_WINDOW_MS = 48 * 3_600_000;
function isMoWebhookRecoveryRecent(lastMoPollRecovery: unknown): boolean {
  if (typeof lastMoPollRecovery !== 'string') return false;
  const stamped = new Date(lastMoPollRecovery).getTime();
  if (Number.isNaN(stamped)) return false;
  return Date.now() - stamped <= MO_RECOVERY_BADGE_WINDOW_MS;
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
    mutationFn: (id: string) => marketingApi.post<VerifyResponse>(`/channels/${id}/verify`),
    onSuccess: ({ data }) => {
      invalidate();
      const ok = !!data?.ok;
      // Headline is ALWAYS the localized copy — `details.message` is a raw
      // provider string (e.g. NetGSM's Turkish error map) and must never
      // replace it, only ever shown as secondary toast description. On
      // failure, split the headline by WHY it failed so the operator doesn't
      // have to read the provider message to know what to do next:
      //  - details.headerApproved === false: creds are fine, the sender ID
      //    (NetGSM msgheader) itself isn't İYS-approved on this account.
      //  - details.credsValid === false: the provider actively rejected the
      //    credentials.
      //  - details.credsValid null/undefined: we couldn't reach the provider
      //    at all (transient outage) — distinct from a rejected credential.
      const headline = ok
        ? t('channels.verifyOk', 'Channel verified ✓')
        : data?.details?.headerApproved === false
          ? t('channels.verifyHeaderNotApproved', 'Sender ID is not approved on this account')
          : data?.details?.credsValid === false
            ? t('channels.verifyFailCreds', 'Verification failed — check credentials')
            : t('channels.verifyUnreachable', 'Could not reach NetGSM — try again');
      const detail = !ok ? (data?.details?.message ?? undefined) : undefined;
      toast[ok ? 'success' : 'error'](headline, detail ? { description: detail } : undefined);
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('channels.verifyFailCreds', 'Verification failed — check credentials')),
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
                      {c.type === 'SMS' && isMoWebhookRecoveryRecent((c.configPublic as Record<string, unknown> | null)?.lastMoPollRecovery) && (
                        <Badge tone="warning" size="sm">
                          {t('channels.moWebhookMissing', 'MO webhook is missing messages — check the NetGSM panel URL')}
                        </Badge>
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
                    loading={verify.isPending && verify.variables === c.id}
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
              {/* İYS (İleti Yönetim Sistemi) compliance — NetGSM Phase 2. Bundled
                  free with the `campaigns` feature (no separate gate/badge here;
                  a workspace without `campaigns` just gets a 403 toast from the
                  save/register actions below, same as any other gated action). */}
              {c.type === 'SMS' && <SmsIysSection channel={c} onSaved={invalidate} />}

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

/**
 * SMS channel card — İYS (İleti Yönetim Sistemi) compliance section (NetGSM
 * Phase 2 Task 6): the brandCode + default message-type config, and the
 * push-back webhook registration action. Also carries the OTP delivery
 * transport preference (NetGSM Phase 6 Task 3, `otpTransport`) — a different
 * concern (verification-code delivery, read by `SmsOtpService`) but the SAME
 * channel row/configPublic, so it shares this card and its Save action
 * rather than opening a second settings surface for one field.
 *
 * Saves via the EXISTING PATCH /channels/:id path (ChannelsService.update),
 * merging client-side onto the channel's current configPublic — the backend
 * replaces configPublic wholesale on update, it does not merge, so sending
 * only { brandCode, iysDefault, otpTransport } here would silently drop
 * unrelated keys the server has stamped (iysWebhookRegistered,
 * lastMoPollRecovery, …).
 *
 * `registerIysWebhook` is bundled free with the `campaigns` feature, not the
 * channel's own `sms` gate — see ChannelsService.registerIysWebhook's doc
 * comment. A workspace without `campaigns` gets a 403 here, surfaced as any
 * other save-failed toast; there is no separate feature check client-side
 * (an inert action that always fails cleanly, same pattern as the rest of
 * this app's gated-but-unhidden actions).
 */
function SmsIysSection({ channel, onSaved }: { channel: ChannelRow; onSaved: () => void }) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const savedPublic = (channel.configPublic as Record<string, unknown> | null) ?? {};
  const savedBrandCode = typeof savedPublic.brandCode === 'string' ? savedPublic.brandCode : '';
  const savedIysDefault = savedPublic.iysDefault === 'TICARI' ? 'TICARI' : 'BILGILENDIRME';
  const registered = savedPublic.iysWebhookRegistered === true;
  // NetGSM Phase 6 Task 3 — OTP delivery transport preference. Anything
  // other than the literal 'WHATSAPP' is SMS (the SmsOtpService default),
  // mirroring the backend's own `pub?.otpTransport === 'WHATSAPP'` read.
  const savedOtpTransport = savedPublic.otpTransport === 'WHATSAPP' ? 'WHATSAPP' : 'SMS';

  const [brandCode, setBrandCode] = useState(savedBrandCode);
  const [iysDefault, setIysDefault] = useState<string>(savedIysDefault);
  const [otpTransport, setOtpTransport] = useState<string>(savedOtpTransport);

  // İYS auto-push DLQ (NetGSM Phase 2 Task 3/6) — workspace-scoped, not
  // per-channel, but read from here since this is the one place an operator
  // manages İYS for SMS. Silently renders nothing (no badge) on a load error
  // or while a workspace has zero DLQ rows — this is a "heads up" surface,
  // not a critical path.
  const dlqQuery = useQuery<{ count: number }>({
    queryKey: ['marketing', 'compliance', 'iysDlqCount'],
    queryFn: () => marketingApi.get('/compliance/iys/dlq-count').then((r) => r.data),
    staleTime: 30_000,
  });

  const retryDlq = useMutation({
    mutationFn: () => marketingApi.post<{ count: number }>('/compliance/iys/retry'),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'compliance', 'iysDlqCount'] });
      toast.success(
        t('channels.iysDlqRetried', {
          defaultValue: '{{count}} job(s) queued for retry',
          count: data?.count ?? 0,
        }),
      );
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('channels.iysDlqRetryFailed', 'Could not retry the failed jobs')),
  });

  const save = useMutation({
    mutationFn: () =>
      marketingApi.patch(`/channels/${channel.id}`, {
        configPublic: { ...savedPublic, brandCode: brandCode.trim(), iysDefault, otpTransport },
      }),
    onSuccess: () => {
      onSaved();
      toast.success(t('channels.iysSaved', 'İYS settings saved'));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('channels.iysSaveFailed', 'Could not save İYS settings')),
  });

  const registerWebhook = useMutation({
    mutationFn: () => marketingApi.post(`/channels/${channel.id}/iys/register-webhook`),
    onSuccess: () => {
      onSaved();
      toast.success(t('channels.iysWebhookRegistered', 'İYS webhook registered with NetGSM'));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('channels.iysWebhookFailed', 'Could not register the İYS webhook')),
  });

  const dirty =
    brandCode.trim() !== savedBrandCode || iysDefault !== savedIysDefault || otpTransport !== savedOtpTransport;

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted-foreground">
          {t('channels.iysTitle', 'İYS (İleti Yönetim Sistemi)')}
        </span>
        <Badge tone={registered ? 'success' : 'neutral'} size="sm">
          {registered
            ? t('channels.iysWebhookOk', 'Webhook registered')
            : t('channels.iysWebhookNotRegistered', 'Webhook not registered')}
        </Badge>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('channels.iysBrandCode', 'İYS Marka Kodu')} className="w-48">
          {({ id }) => (
            <Input
              id={id}
              placeholder={t('channels.iysBrandCodePlaceholder', 'Marka kodu')}
              value={brandCode}
              onChange={(e) => setBrandCode(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('channels.iysDefault', 'Varsayılan mesaj türü')} className="w-56">
          {({ id }) => (
            <Select value={iysDefault} onValueChange={setIysDefault}>
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BILGILENDIRME">{t('channels.iysBilgilendirme', 'Bilgilendirme')}</SelectItem>
                <SelectItem value="TICARI">{t('channels.iysTicari', 'Ticari')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Button size="sm" variant="outline" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
          {t('common.save', 'Save')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => registerWebhook.mutate()}
          loading={registerWebhook.isPending}
          // The backend registers the PERSISTED brandCode, not the typed one, so
          // block registration while there are unsaved changes — otherwise it
          // would silently register the old saved code. Save first.
          disabled={!brandCode.trim() || dirty}
        >
          {t('channels.iysRegisterWebhook', "İYS webhook'unu kaydet")}
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">
        {t(
          'channels.iysHelp',
          "İYS panelinizden aldığınız marka kodunu girip webhook'u kaydedin — ticari SMS onay/red durumları otomatik senkronize edilir.",
        )}
      </p>
      {/* NetGSM Phase 6 Task 3 — OTP delivery transport preference. Rides the
          SAME channel row + Save button above (part of the same PATCH), a
          separate field group only for visual grouping since it governs
          verification-code delivery, not campaign compliance like the İYS
          fields above it. Default SMS; WhatsApp needs the paid "OTP
          WhatsApp" package + an approved netgsm_verify_code template — any
          failure/absence falls back to SMS automatically (SmsOtpService),
          so a code is never silently undelivered. */}
      <div className="flex flex-wrap items-end gap-2 pt-1">
        <Field label={t('channels.otpTransport', 'OTP delivery channel')} className="w-64">
          {({ id }) => (
            <Select value={otpTransport} onValueChange={setOtpTransport}>
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SMS">{t('channels.otpTransportSms', 'SMS (default)')}</SelectItem>
                <SelectItem value="WHATSAPP">{t('channels.otpTransportWhatsapp', 'WhatsApp')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
      <p className="text-caption text-muted-foreground">
        {t(
          'channels.otpTransportHelp',
          'Which channel verification codes (2FA, phone verification) are sent over. WhatsApp requires a paid "OTP WhatsApp" package and an approved netgsm_verify_code template on your NetGSM account — if the package is missing or the send fails, the code automatically falls back to SMS.',
        )}
      </p>
      {/* İYS auto-push DLQ warning (NetGSM Phase 2 Task 6): a job escalates
          here after 8 failed attempts (bad creds, brandCode, or a standing
          NetGSM rejection) — surfaced with a one-click retry rather than
          leaving it silently stuck until someone thinks to check the DB. */}
      {!!dlqQuery.data?.count && (
        <Callout tone="warning" className="p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-caption">
              {t('channels.iysDlqBacklog', {
                defaultValue: '{{count}} İYS senkronizasyonu başarısız oldu (DLQ)',
                count: dlqQuery.data.count,
              })}
            </span>
            <Button size="sm" variant="outline" onClick={() => retryDlq.mutate()} loading={retryDlq.isPending}>
              {t('channels.iysDlqRetry', 'Yeniden dene')}
            </Button>
          </div>
        </Callout>
      )}
    </div>
  );
}
