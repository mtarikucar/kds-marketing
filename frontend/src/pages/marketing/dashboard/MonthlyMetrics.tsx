import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardContent, Skeleton } from '@/components/ui';

interface Monthly {
  month?: string;
  newLeads?: number;
  wonLeads?: number;
  activitiesCount?: number;
}

interface MonthlyMetricsProps {
  monthly?: Monthly;
}

export function MonthlyMetrics({ monthly }: MonthlyMetricsProps) {
  const { t } = useTranslation('marketing');

  if (!monthly) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.thisMonth')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const rows = [
    {
      label: t('leadStatus.NEW'),
      value: monthly.newLeads ?? 0,
      className: '',
    },
    {
      label: t('leadStatus.WON'),
      value: monthly.wonLeads ?? 0,
      className: 'text-success',
    },
    {
      label: t('leadDetail.tabs.activities'),
      value: monthly.activitiesCount ?? 0,
      className: '',
    },
  ];

  const isEmpty = rows.every((row) => row.value === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('dashboard.thisMonth')}
          {monthly.month && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({monthly.month})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <p className="py-2 text-sm text-muted-foreground">
            {t('dashboard.nothingThisMonth', 'No activity yet this month.')}
          </p>
        ) : (
          <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">{row.label}</span>
              <span className={`font-medium tabular-nums ${row.className || 'text-foreground'}`}>
                {row.value}
              </span>
            </div>
          ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
