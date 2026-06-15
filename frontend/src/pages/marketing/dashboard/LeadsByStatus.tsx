import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardContent, Badge, Skeleton, type BadgeProps } from '@/components/ui';
import { LeadStatus } from '../../../features/marketing/types';

interface StatusItem {
  status: string;
  count: number;
}

interface LeadsByStatusProps {
  leadsByStatus?: StatusItem[];
}

/** Map each LeadStatus to a Badge tone. */
const STATUS_TONE: Record<string, BadgeProps['tone']> = {
  [LeadStatus.NEW]: 'info',
  [LeadStatus.CONTACTED]: 'primary',
  [LeadStatus.NOT_REACHABLE]: 'warning',
  [LeadStatus.MEETING_DONE]: 'neutral',
  [LeadStatus.DEMO_SCHEDULED]: 'info',
  [LeadStatus.OFFER_SENT]: 'warning',
  [LeadStatus.WAITING]: 'neutral',
  [LeadStatus.WON]: 'success',
  [LeadStatus.LOST]: 'danger',
};

export function LeadsByStatus({ leadsByStatus }: LeadsByStatusProps) {
  const { t } = useTranslation('marketing');

  if (!leadsByStatus) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.byStatus')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (leadsByStatus.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.byStatus')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {leadsByStatus.map((item) => (
            <div
              key={item.status}
              className="flex flex-col items-center gap-2 p-3 rounded-lg bg-surface-muted"
            >
              <Badge tone={STATUS_TONE[item.status] ?? 'neutral'} size="sm">
                {t(`leadStatus.${item.status}`, { defaultValue: item.status })}
              </Badge>
              <p className="font-display text-h2 tabular-nums text-foreground">{item.count}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
