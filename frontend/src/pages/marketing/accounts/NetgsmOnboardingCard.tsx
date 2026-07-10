import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ListChecks,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronRight,
  ArrowRight,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Callout } from '@/components/ui/Callout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { CopyField } from './CopyField';

type OnboardingState = 'ok' | 'missing' | 'unknown';

interface OnboardingItem {
  key: string;
  state: OnboardingState;
  detail?: string;
  url?: string;
}

const onboardingKey = ['marketing', 'netgsm', 'onboarding'] as const;

/** Fixed i18n-able detail keys the backend sends instead of hardcoded prose
 *  (e.g. which credential source a live probe used) — never render these raw. */
const DETAIL_I18N_FALLBACK: Record<string, string> = {
  viaSantralCreds: 'Probed via your shared Netsantral credentials',
  noSantralConfig: 'Not probed yet — no Netsantral credentials saved',
  eventsWebhookHint: 'Paste into: Netsantral panel > Settings > General Settings > API Request Settings',
  // NetGSM SMS v2 Task 12 — there is no read-only probe for the OTP package
  // (only a real send reveals it); explains what NetGSM error 60 means
  // instead of pretending to check it live.
  otpPackageHint:
    "Can't be checked without sending a real code — if OTP sends fail with NetGSM error 60, the OTP package isn't active on this NetGSM account yet.",
  // NetGSM SMS v2 Task 13 — senderHeaders degrades to 'unknown' (rather than a
  // false 'missing') when there's no SMS channel/creds/msgheader to check yet,
  // or NetGSM's own approved-header list endpoint is temporarily unreachable.
  headersUnavailable:
    "Can't be checked yet — no sender header saved on the SMS channel, or NetGSM's approved-header list is temporarily unavailable.",
  // NetGSM Phase 3 Task 7 — eventsWebhookReceiving's remedy hint, shown only
  // while the row is 'unknown' (no events-purpose webhook has landed yet).
  eventsWebhookReceivingHint: 'Register the URL in the panel and place a test call',
  // NetGSM Phase 4 Task 7 — recordingStorage's persistent compliance
  // reminder, shown regardless of ok/missing/unknown: KVKK requires telling
  // the caller a call is being recorded before recording starts.
  recordingStorageKvkkHint:
    'KVKK requires announcing to the caller that the call is being recorded — add this to your IVR/greeting before turning recording on.',
  // NetGSM Phase 4 Task 7 — recordingsReceiving's remedy hint, shown only
  // while the row is 'unknown' (no recorded call has landed yet).
  recordingsReceivingHint: 'Place and finish a recorded call to verify recordings are being stored',
  // NetGSM Phase 5 Task 3 — voiceReportWebhook is a read-only reference URL
  // (campaign-sender.service.ts mints it automatically per VOICE send), not
  // a manual paste step like eventsWebhookUrl — this hint explains why.
  voiceReportWebhookHint: 'Set automatically on every VOICE campaign call — nothing to paste manually',
  // NetGSM Phase 5 Task 7 — voicePackage has no live probe (same reasoning as
  // otpPackage): only a real voicesms/send or autocallservice call reveals
  // whether either add-on is active, and both fail the same way (code 60).
  voicePackageHint:
    "Can't be checked without sending a real voice call — Voice SMS and Otomatik Arama (auto-dialer) are separate paid NetGSM add-ons; sends fail with NetGSM error 60 until each is activated on your account.",
  // NetGSM Phase 5 Task 7 — autocallQueue is entirely Netsantral-portal state
  // (queue existence + agent login), nothing this app can read or set.
  autocallQueueHint:
    'The auto-dialer needs a Netsantral queue with logged-in agents to connect answered calls to — set this up in the Netsantral panel.',
  // NetGSM Phase 6 Task 1 — faxNumber has no live probe (fax reuses the SMS
  // channel's own creds, same as voicePackage/otpPackage above); this hint
  // names the portal-only, paid prerequisite.
  faxNumberHint:
    'A fax-enabled NetGSM number is required (set up in the NetGSM portal) — fax send/receive will not work without it.',
  // NetGSM Phase 6 Task 3 — whatsappOtpPackage has no live probe (sending a
  // real WhatsApp OTP just to check would be an unwanted send, same
  // reasoning as otpPackage); this hint explains the silent SMS fallback.
  whatsappOtpPackageHint:
    'WhatsApp OTP needs a paid OTP-WhatsApp package and Meta template approval on your NetGSM account — until then, OTP codes are sent over SMS automatically.',
  // NetGSM Phase 6 Task 4 — shown only while netasistanKeys is 'unknown'
  // (not yet configured); Netasistan is an opt-in add-on, not a required step.
  netasistanKeysHint: 'Configure your Netasistan app-key and user-key to sync agent break/queue presence.',
  // Guided setup — ivrWebhook's two detail states. 'missing' = the
  // platform-level NETGSM_IVR_TOKEN env is unset (the public IVR route 404s);
  // once set, the URL carries a {token} placeholder the platform operator
  // substitutes (the token is platform-wide — never rendered per-workspace).
  ivrTokenMissing:
    'Dynamic IVR is not enabled on this platform yet (NETGSM_IVR_TOKEN is unset) — ask your platform operator to configure it.',
  ivrWebhookHint:
    'Paste into NetGSM "Özel API (Custom)" — replace {token} with the platform IVR token (ask your platform operator).',
};

/** Where a 'missing' step gets fixed — drives the per-step CTA link. */
type FixTarget = 'channels' | 'telephony';
const FIX_ROUTE: Record<FixTarget, string> = {
  channels: '/inbox?tab=channels',
  telephony: '/accounts?tab=accounts&focus=telephony',
};

interface StepMeta {
  fix?: FixTarget;
  /** Paid NetGSM add-on the app can neither buy nor verify — badge + honesty. */
  paid?: boolean;
}

const STEP_META: Record<string, StepMeta> = {
  smsChannel: { fix: 'channels' },
  smsCredsLive: { fix: 'telephony' }, // probed via the shared Netsantral creds
  senderHeaders: { fix: 'channels' }, // msgheader lives on the SMS channel
  moUrl: {},
  otpPackage: { paid: true },
  iysBrandCode: { fix: 'channels' },
  iysWebhook: { fix: 'channels' }, // register button lives in channel settings
  iysFirstSync: {},
  telephonyConfig: { fix: 'telephony' },
  santralCredsLive: { fix: 'telephony' },
  repsWithDahili: { fix: 'telephony' },
  eventsWebhookUrl: {},
  eventsWebhookReceiving: {},
  recordingStorage: { fix: 'telephony' },
  recordingsReceiving: {},
  voicePackage: { paid: true },
  ivrWebhook: {}, // platform env — no tenant-side fix surface
  voiceReportWebhook: {},
  autocallQueue: {},
  faxNumber: { paid: true },
  whatsappOtpPackage: { paid: true },
  netasistanKeys: { fix: 'telephony' },
};

/** Dependency-ordered setup phases. Steps not listed here (a future backend
 *  addition) fall into a trailing catch-all group so nothing silently drops. */
interface GroupDef {
  key: string;
  steps: string[];
  optional?: boolean;
}

const GROUPS: GroupDef[] = [
  { key: 'sms', steps: ['smsChannel', 'smsCredsLive', 'senderHeaders', 'moUrl', 'otpPackage'] },
  { key: 'iys', steps: ['iysBrandCode', 'iysWebhook', 'iysFirstSync'] },
  {
    key: 'santral',
    steps: ['telephonyConfig', 'santralCredsLive', 'repsWithDahili', 'eventsWebhookUrl', 'eventsWebhookReceiving'],
  },
  { key: 'recording', steps: ['recordingStorage', 'recordingsReceiving'], optional: true },
  { key: 'voice', steps: ['voicePackage', 'ivrWebhook', 'voiceReportWebhook', 'autocallQueue'], optional: true },
  { key: 'addons', steps: ['faxNumber', 'whatsappOtpPackage', 'netasistanKeys'], optional: true },
];

const GROUP_FALLBACKS: Record<string, { title: string; desc: string }> = {
  sms: { title: 'SMS foundation', desc: 'The base NetGSM account — santral, fax, voice and OTP all reuse it.' },
  iys: { title: 'İYS compliance', desc: 'Required before any commercial (TİCARİ) SMS or voice send.' },
  santral: { title: 'Phone (Netsantral)', desc: 'Live call events, inbound screen-pop and in-call control.' },
  recording: { title: 'Call recording & queues', desc: 'Store recordings (R2) with a retention sweep.' },
  voice: { title: 'Voice campaigns & IVR', desc: 'Voice SMS, auto-dialer and the dynamic IVR robot.' },
  addons: { title: 'Add-ons', desc: 'Fax, WhatsApp OTP and Netasistan presence sync.' },
  other: { title: 'Other', desc: 'New checks not yet grouped.' },
};

/**
 * NetGSM guided setup — the manual portal steps a tenant must click through in
 * NetGSM's own panel (it exposes no provisioning API), organized as
 * dependency-ordered phases with a live check where an API read exists.
 * Complete groups collapse; the first group still carrying a 'missing' step
 * auto-expands. Each fixable step deep-links to the surface that fixes it.
 */
export function NetgsmOnboardingCard() {
  const { t } = useTranslation('marketing');
  // User group toggles override the computed default (first incomplete open).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const { data, isLoading, isError, refetch } = useQuery<{ items: OnboardingItem[] }>({
    queryKey: onboardingKey,
    queryFn: () => marketingApi.get('/netgsm/onboarding').then((r) => r.data),
    staleTime: 30_000,
  });

  const itemLabel = (key: string): string => {
    const fallbacks: Record<string, string> = {
      smsChannel: 'SMS channel connected',
      smsCredsLive: 'SMS credentials verified live',
      moUrl: 'Inbound (MO) callback URL',
      telephonyConfig: 'Netsantral telephony configured',
      santralCredsLive: 'Netsantral credentials verified live',
      repsWithDahili: 'Reps with a dahili (extension)',
      eventsWebhookUrl: 'Events webhook URL',
      eventsWebhookReceiving: 'Switchboard events webhook receiving traffic',
      otpPackage: 'SMS OTP package',
      senderHeaders: 'Sender header (msgheader) İYS-approved',
      iysWebhook: 'İYS push-back webhook registered',
      iysBrandCode: 'İYS marka kodu (brand code) configured',
      iysFirstSync: 'First İYS consent sync confirmed',
      recordingStorage: 'Call recording storage (R2) configured',
      recordingsReceiving: 'Recordings being stored',
      voicePackage: 'Voice SMS / Otomatik Arama package',
      ivrWebhook: 'Dynamic IVR webhook URL',
      voiceReportWebhook: 'Voice-campaign report webhook URL',
      autocallQueue: 'Netsantral queue with logged-in agents',
      faxNumber: 'Fax-enabled NetGSM number',
      whatsappOtpPackage: 'WhatsApp OTP package',
      netasistanKeys: 'Netasistan app-key / user-key configured',
    };
    return t(`accounts.netgsm.${key}`, fallbacks[key] ?? key);
  };

  const itemDetail = (item: OnboardingItem): string | null => {
    if (!item.detail) return null;
    if (item.key === 'repsWithDahili') {
      const count = Number(item.detail);
      return t('accounts.netgsm.repsCount', {
        defaultValue: '{{count}} rep(s) with a dahili configured',
        count: Number.isFinite(count) ? count : item.detail,
      });
    }
    if (item.detail in DETAIL_I18N_FALLBACK) {
      return t(`accounts.netgsm.detail.${item.detail}`, DETAIL_I18N_FALLBACK[item.detail]);
    }
    // Defensive fallback — an unrecognized detail key still renders as-is
    // rather than silently disappearing.
    return item.detail;
  };

  const items = data?.items ?? [];
  const byKey = new Map(items.map((i) => [i.key, i]));

  // Anything the backend added that GROUPS doesn't know yet lands in a
  // trailing catch-all group — a new checklist row must never silently drop.
  const groupedKeys = new Set(GROUPS.flatMap((g) => g.steps));
  const ungrouped = items.filter((i) => !groupedKeys.has(i.key)).map((i) => i.key);
  const groups: GroupDef[] = ungrouped.length
    ? [...GROUPS, { key: 'other', steps: ungrouped, optional: true }]
    : GROUPS;

  // Progress counts only steps that CURRENTLY report a definite ok/missing —
  // always-'unknown' rows (paid packages, no-read-back webhooks) would make
  // 100% unreachable, so they stay out of the denominator.
  const checkable = items.filter((i) => i.state !== 'unknown');
  const okCount = checkable.filter((i) => i.state === 'ok').length;
  const pct = checkable.length > 0 ? Math.round((okCount / checkable.length) * 100) : 0;

  // Default focus: the first group still carrying a 'missing' step opens.
  const firstIncomplete = groups.find((g) =>
    g.steps.some((k) => byKey.get(k)?.state === 'missing'),
  )?.key;
  const isExpanded = (key: string) => toggled[key] ?? key === firstIncomplete;

  const iysBlocked = byKey.get('iysBrandCode')?.state === 'missing';

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted"
            style={{ color: '#0EA5E9' }}
          >
            <ListChecks className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">{t('accounts.netgsm.title', 'NetGSM Setup')}</p>
            <p className="text-caption text-muted-foreground">
              {t(
                'accounts.netgsm.subtitle',
                "Manual steps in NetGSM's own panel — with a live check where possible.",
              )}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ) : isError ? (
          <Callout tone="danger">
            <p>{t('accounts.loadError', "Couldn't load your connections.")}</p>
            <button type="button" className="text-caption underline" onClick={() => refetch()}>
              {t('common.retry', 'Retry')}
            </button>
          </Callout>
        ) : (
          <>
            {checkable.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-caption">
                  <span className="text-muted-foreground">
                    {t('accounts.netgsm.progress', {
                      defaultValue: '{{done}}/{{total}} verifiable steps done',
                      done: okCount,
                      total: checkable.length,
                    })}
                  </span>
                  <span className="font-medium text-foreground">{pct}%</span>
                </div>
                <Progress value={pct} tone={pct === 100 ? 'success' : 'info'} />
              </div>
            )}

            <ul className="space-y-2">
              {groups.map((group, idx) => {
                const steps = group.steps
                  .map((k) => byKey.get(k))
                  .filter((i): i is OnboardingItem => Boolean(i));
                if (steps.length === 0) return null;
                const missing = steps.filter((s) => s.state === 'missing').length;
                const groupOk = steps.filter((s) => s.state === 'ok').length;
                const groupCheckable = steps.filter((s) => s.state !== 'unknown').length;
                const complete = groupCheckable > 0 && missing === 0;
                const open = isExpanded(group.key);
                const fb = GROUP_FALLBACKS[group.key] ?? { title: group.key, desc: '' };
                return (
                  <li key={group.key} className="rounded-lg border border-border">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 p-2.5 text-left"
                      aria-expanded={open}
                      onClick={() => setToggled((s) => ({ ...s, [group.key]: !open }))}
                    >
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-micro font-semibold ${
                          complete ? 'bg-success-subtle text-success' : 'bg-surface-muted text-muted-foreground'
                        }`}
                        aria-hidden="true"
                      >
                        {complete ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {t(`accounts.netgsm.group.${group.key}.title`, fb.title)}
                        </span>
                        <span className="block truncate text-caption text-muted-foreground">
                          {t(`accounts.netgsm.group.${group.key}.desc`, fb.desc)}
                        </span>
                      </span>
                      {group.optional && (
                        <Badge tone="neutral" size="sm">
                          {t('accounts.netgsm.badge.optional', 'Optional')}
                        </Badge>
                      )}
                      {missing > 0 ? (
                        <Badge tone="danger" size="sm">
                          {t('accounts.netgsm.missingCount', {
                            defaultValue: '{{count}} to fix',
                            count: missing,
                          })}
                        </Badge>
                      ) : groupCheckable > 0 ? (
                        <Badge tone={complete ? 'success' : 'neutral'} size="sm">
                          {groupOk}/{groupCheckable}
                        </Badge>
                      ) : null}
                      {open ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                    </button>

                    {open && (
                      <div className="space-y-2 border-t border-border p-2.5">
                        {group.key === 'iys' && iysBlocked && (
                          <Callout tone="warning">
                            {t(
                              'accounts.netgsm.iysBlocked',
                              'Commercial (TİCARİ) SMS and voice sends are blocked until the İYS marka kodu is configured — informational (BİLGİLENDİRME) sends still work.',
                            )}
                          </Callout>
                        )}
                        <ul className="space-y-2">
                          {steps.map((item) => {
                            const meta = STEP_META[item.key] ?? {};
                            const detail = itemDetail(item);
                            return (
                              <li key={item.key} className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <StateIcon state={item.state} />
                                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                    {itemLabel(item.key)}
                                  </span>
                                  {meta.paid && (
                                    <Badge tone="info" size="sm">
                                      {t('accounts.netgsm.badge.paid', 'Paid NetGSM add-on')}
                                    </Badge>
                                  )}
                                  {meta.fix && item.state === 'missing' && (
                                    <Button asChild variant="outline" size="sm">
                                      <Link to={FIX_ROUTE[meta.fix]}>
                                        {meta.fix === 'channels'
                                          ? t('accounts.netgsm.fixChannels', 'Open channel settings')
                                          : t('accounts.netgsm.fixTelephony', 'Open phone card')}
                                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                                      </Link>
                                    </Button>
                                  )}
                                </div>
                                {detail && <p className="pl-6 text-caption text-muted-foreground">{detail}</p>}
                                {item.url && (
                                  <div className="pl-6">
                                    <CopyField value={item.url} />
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StateIcon({ state }: { state: OnboardingState }) {
  if (state === 'ok') {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />;
  }
  if (state === 'missing') {
    return <XCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />;
  }
  return <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}
