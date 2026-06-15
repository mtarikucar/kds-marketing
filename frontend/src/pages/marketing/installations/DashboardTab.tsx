import {
  InstallationStatus,
  INSTALLATION_STATUS_LABELS,
} from '../../../features/marketing/types';
import type { InstallationDashboard, InstallationJob } from '../../../features/marketing/types';
import { fmtDate } from '../../../features/marketing/utils/format';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  StatCard,
  Badge,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
} from '../../../components/ui';
import { CalendarDays } from 'lucide-react';
import type { BadgeProps } from '../../../components/ui/Badge';

const STATUSES = Object.values(InstallationStatus);

/** Map InstallationStatus to a Console Badge tone. */
function statusTone(
  status: string,
): NonNullable<BadgeProps['tone']> {
  switch (status) {
    case 'REQUESTED':    return 'neutral';
    case 'SCHEDULED':    return 'info';
    case 'IN_PROGRESS':  return 'warning';
    case 'DONE':         return 'success';
    case 'CANCELLED':    return 'danger';
    case 'NO_SHOW':      return 'danger';
    default:             return 'neutral';
  }
}

interface Props {
  dashboard?: InstallationDashboard;
  onJobClick: (jobId: string) => void;
}

export function DashboardTab({ dashboard, onJobClick }: Props) {
  return (
    <div className="space-y-4">
      {/* Status stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {STATUSES.map((s) => (
          <StatCard
            key={s}
            label={INSTALLATION_STATUS_LABELS[s]}
            value={String(dashboard?.byStatus?.[s] ?? 0)}
          />
        ))}
        <StatCard
          label="Unscheduled"
          value={String(dashboard?.unscheduled ?? 0)}
          tone={dashboard && dashboard.unscheduled > 0 ? 'warning' : 'success'}
        />
        <StatCard
          label="Overdue SLA"
          value={String(dashboard?.overdueSla ?? 0)}
          tone={dashboard && dashboard.overdueSla > 0 ? 'danger' : 'success'}
        />
      </div>

      {/* Upcoming jobs */}
      <Card>
        <CardHeader>
          <CardTitle>Upcoming (next 7 days)</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Contact / Site</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Scheduled</TH>
                <TH className="hidden md:table-cell">Window</TH>
              </TR>
            </THead>
            <TBody>
              {(dashboard?.upcoming || []).length === 0 ? (
                <TR>
                  <TD colSpan={4} className="py-0">
                    <EmptyState
                      icon={<CalendarDays className="h-8 w-8" />}
                      title="No upcoming jobs"
                      description="Nothing scheduled in the next 7 days."
                      className="rounded-none border-0"
                    />
                  </TD>
                </TR>
              ) : (
                dashboard!.upcoming.map((j: InstallationJob) => (
                  <TR
                    key={j.id}
                    className="cursor-pointer"
                    onClick={() => onJobClick(j.id)}
                  >
                    <TD>
                      <p className="font-medium text-foreground">{j.contactName || '—'}</p>
                      <p className="text-xs text-muted-foreground">
                        {j.siteCity || j.siteAddress || ''}
                      </p>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(j.status)}>
                        {INSTALLATION_STATUS_LABELS[j.status as InstallationStatus] || j.status}
                      </Badge>
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground">
                      {j.scheduledDate ? fmtDate(j.scheduledDate) : '—'}
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground">
                      {j.scheduledWindow || '—'}
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
