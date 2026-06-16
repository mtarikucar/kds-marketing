import { useTranslation } from 'react-i18next';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from '@/components/ui';

interface Performer {
  id: string;
  name: string;
  totalLeads: number;
  openLeads?: number;
  totalActivities: number;
  wonThisMonth: number;
}

interface TopPerformersProps {
  topPerformers: Performer[];
}

/** Manager-only table — caller must gate rendering with isManager check. */
export function TopPerformers({ topPerformers }: TopPerformersProps) {
  const { t } = useTranslation('marketing');

  if (topPerformers.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.topPerformers')}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <THead>
            <TR>
              <TH>{t('users.table.name')}</TH>
              <TH numeric>{t('dashboard.totalLeads')}</TH>
              <TH numeric>{t('dashboard.openLeads')}</TH>
              <TH numeric>{t('leadDetail.tabs.activities')}</TH>
              <TH numeric>{t('leadStatus.WON')}</TH>
            </TR>
          </THead>
          <TBody>
            {topPerformers.map((rep) => (
              <TR key={rep.id}>
                <TD className="font-medium text-foreground">{rep.name}</TD>
                <TD numeric>{rep.totalLeads}</TD>
                <TD numeric>{rep.openLeads ?? 0}</TD>
                <TD numeric>{rep.totalActivities}</TD>
                <TD numeric className="text-success font-medium">
                  {rep.wonThisMonth}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
