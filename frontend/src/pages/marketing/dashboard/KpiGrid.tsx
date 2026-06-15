import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Users,
  Star,
  XCircle,
  TrendingUp,
  FileText,
  ClipboardList,
  Inbox,
} from 'lucide-react';
import { StatCard, Skeleton } from '@/components/ui';

interface Stats {
  totalLeads?: number;
  wonLeads?: number;
  lostLeads?: number;
  conversionRate?: number;
  newLeads?: number;
  activeOffers?: number;
  pendingTasks?: number;
  unassignedLeads?: number;
}

interface KpiGridProps {
  stats?: Stats;
  isManager: boolean;
}

export function KpiGrid({ stats, isManager }: KpiGridProps) {
  const { t } = useTranslation('marketing');

  if (!stats) {
    return (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${isManager ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-4`}>
          {Array.from({ length: isManager ? 4 : 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </>
    );
  }

  const unassigned = stats.unassignedLeads ?? 0;
  const unassignedTone =
    unassigned > 10 ? 'danger' : unassigned > 0 ? 'warning' : 'success';

  return (
    <>
      {/* Primary KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t('dashboard.totalLeads')}
          value={String(stats.totalLeads ?? 0)}
          icon={<Users className="w-5 h-5" />}
          tone="neutral"
        />
        <StatCard
          label={t('leadStatus.WON')}
          value={String(stats.wonLeads ?? 0)}
          icon={<Star className="w-5 h-5" />}
          tone="success"
        />
        <StatCard
          label={t('leadStatus.LOST')}
          value={String(stats.lostLeads ?? 0)}
          icon={<XCircle className="w-5 h-5" />}
          tone="danger"
        />
        <StatCard
          label={t('dashboard.conversionRate')}
          value={`${stats.conversionRate ?? 0}%`}
          icon={<TrendingUp className="w-5 h-5" />}
          tone="info"
        />
      </div>

      {/* Secondary KPI row */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 ${
          isManager ? 'lg:grid-cols-4' : 'lg:grid-cols-3'
        } gap-4`}
      >
        <StatCard label={t('leadStatus.NEW')} value={String(stats.newLeads ?? 0)} tone="primary" />
        <StatCard
          label={t('dashboard.openOffers')}
          value={String(stats.activeOffers ?? 0)}
          icon={<FileText className="w-5 h-5" />}
          tone="warning"
        />
        <StatCard
          label={t('dashboard.pendingTasks')}
          value={String(stats.pendingTasks ?? 0)}
          icon={<ClipboardList className="w-5 h-5" />}
          tone="neutral"
        />
        {isManager && (
          <Link to="/leads?assignmentStatus=unassigned" className="block">
            <StatCard
              label={t('dashboard.unassignedLeads')}
              value={String(unassigned)}
              icon={<Inbox className="w-5 h-5" />}
              tone={unassignedTone}
              className="h-full"
            />
          </Link>
        )}
      </div>
    </>
  );
}
