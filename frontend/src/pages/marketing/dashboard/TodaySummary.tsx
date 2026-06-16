import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardContent, Skeleton } from '@/components/ui';

interface Today {
  todayTasks?: number;
  completedTasks?: number;
  todayActivities?: number;
  overdueTasks?: number;
}

interface TodaySummaryProps {
  today?: Today;
}

export function TodaySummary({ today }: TodaySummaryProps) {
  const { t } = useTranslation('marketing');

  if (!today) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.today')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const rows = [
    {
      label: t('tasks.tabs.today'),
      value: today.todayTasks ?? 0,
      className: '',
    },
    {
      label: t('taskStatus.COMPLETED'),
      value: today.completedTasks ?? 0,
      className: 'text-success',
    },
    {
      label: t('leadDetail.tabs.activities'),
      value: today.todayActivities ?? 0,
      className: '',
    },
    {
      label: t('tasks.tabs.overdue'),
      value: today.overdueTasks ?? 0,
      className: 'text-danger',
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.today')}</CardTitle>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}
