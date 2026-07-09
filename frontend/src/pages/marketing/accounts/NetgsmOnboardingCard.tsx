import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ListChecks, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Callout } from '@/components/ui/Callout';
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
};

/**
 * NetGSM setup checklist — the manual portal steps a tenant must click
 * through in NetGSM's own panel (it exposes no provisioning API), each row
 * showing a live check where an API read exists. Read-only: this card never
 * writes anything, it just tells the owner what's left to configure and
 * gives them the URL to paste where one is needed.
 */
export function NetgsmOnboardingCard() {
  const { t } = useTranslation('marketing');

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
          <div className="min-w-0">
            <p className="font-medium text-foreground">{t('accounts.netgsm.title', 'NetGSM Setup Checklist')}</p>
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
            <button
              type="button"
              className="text-caption underline"
              onClick={() => refetch()}
            >
              {t('common.retry', 'Retry')}
            </button>
          </Callout>
        ) : (
          <ul className="space-y-2">
            {(data?.items ?? []).map((item) => (
              <li key={item.key} className="space-y-1.5 rounded-lg border border-border p-2.5">
                <div className="flex items-center gap-2">
                  <StateIcon state={item.state} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {itemLabel(item.key)}
                  </span>
                </div>
                {itemDetail(item) && (
                  <p className="pl-6 text-caption text-muted-foreground">{itemDetail(item)}</p>
                )}
                {item.url && (
                  <div className="pl-6">
                    <CopyField value={item.url} />
                  </div>
                )}
              </li>
            ))}
          </ul>
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
