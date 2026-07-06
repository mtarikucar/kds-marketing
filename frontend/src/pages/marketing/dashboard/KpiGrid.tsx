import { useTranslation } from 'react-i18next';
import { Users, TrendingUp } from 'lucide-react';
import { StatCard, Skeleton } from '@/components/ui';

interface Stats {
  totalLeads?: number;
  conversionRate?: number;
}

interface KpiGridProps {
  stats?: Stats;
}

/**
 * The dashboard's KPI tiles — trimmed (2026-07) to the TWO numbers no other
 * section shows: Total leads and Conversion rate. Everything the old 8-tile
 * grid duplicated appears exactly once elsewhere on the same page:
 * NEW/WON/LOST live in LeadsByStatus (with tones), and the actionable queues
 * (open offers / pending tasks / unassigned) are NeedsAttention's deep-link
 * cards, with the all-clear state covered by the Hero.
 */
export function KpiGrid({ stats }: KpiGridProps) {
  const { t } = useTranslation('marketing');

  if (!stats) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <StatCard
        label={t('dashboard.totalLeads')}
        value={String(stats.totalLeads ?? 0)}
        icon={<Users className="w-5 h-5" />}
        tone="neutral"
      />
      <StatCard
        label={t('dashboard.conversionRate')}
        value={`${stats.conversionRate ?? 0}%`}
        icon={<TrendingUp className="w-5 h-5" />}
        tone="info"
      />
    </div>
  );
}
