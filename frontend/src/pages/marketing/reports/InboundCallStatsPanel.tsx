import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhoneIncoming, PhoneMissed, Clock } from 'lucide-react';
import { getTelephonyStatistics } from '../../../features/marketing/api/telephony-statistics.service';
import { fmtDuration } from '../../../features/marketing/utils/format';
import { Card, CardContent, Spinner } from '../../../components/ui';

const STATS_KEY = ['marketing', 'telephony', 'statistics'] as const;

/**
 * Inbound call statistics panel (NetGSM Phase 4 Task 5) — answered/abandoned/
 * avg-wait for the last 7 days, on `GET /marketing/telephony/statistics`
 * (mode 1 daily aggregates from `/netsantral/statistics`; NetGSM's own ≤7-day
 * window for that mode — the backend clamps a wider request rather than
 * erroring).
 *
 * Same off-prod caveat as the CDR probe on TelephonyCard (`showCdrNote`):
 * `/netsantral/statistics` only authenticates from NetGSM's allow-listed
 * production IP, so a local/staging call comes back 200 with `ok:false` +
 * a NetGSM error `code` even with valid credentials — rendered here as an
 * informational note rather than an error state.
 *
 * Self-contained: mount only where the workspace is telephony-entitled (the
 * caller gates that — see ReportsPage's Overview tab), since the underlying
 * route 503s for a workspace with no active Netsantral config.
 */
export default function InboundCallStatsPanel() {
  const { t } = useTranslation('marketing');

  const { data, isLoading, isError } = useQuery({
    queryKey: STATS_KEY,
    queryFn: () => getTelephonyStatistics(),
    retry: false,
  });

  if (isError) {
    return (
      <Card>
        <CardContent className="py-4 text-caption text-muted-foreground">
          {t('inboundStats.loadError', 'Could not load call statistics.')}
        </CardContent>
      </Card>
    );
  }

  const summary = data?.summary;
  const showOffProdNote = !!data && !data.ok;

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <h3 className="text-body font-semibold text-foreground">
          {t('inboundStats.title', 'Inbound calls (last 7 days)')}
        </h3>

        {isLoading ? (
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            <Spinner className="h-4 w-4" />
          </div>
        ) : (
          <div className="flex flex-wrap gap-6">
            <Stat
              icon={PhoneIncoming}
              label={t('inboundStats.answered', 'Answered')}
              value={summary?.answered ?? 0}
            />
            <Stat
              icon={PhoneMissed}
              label={t('inboundStats.abandoned', 'Abandoned')}
              value={summary?.abandoned ?? 0}
            />
            <Stat
              icon={Clock}
              label={t('inboundStats.avgWait', 'Avg wait')}
              value={summary?.avgWaitSec != null ? fmtDuration(summary.avgWaitSec) : '—'}
            />
          </div>
        )}

        {showOffProdNote && (
          <p className="text-caption text-muted-foreground">
            {t(
              'inboundStats.offProdNote',
              'Call statistics can only be confirmed from the production server IP (NetGSM allow-list).',
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof PhoneIncoming;
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="text-body font-semibold text-foreground">{value}</span>
    </div>
  );
}
