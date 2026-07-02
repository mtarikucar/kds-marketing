import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { UserPlus, ArrowRight } from 'lucide-react';
import { Card, Button, EmptyState } from '@/components/ui';

interface HeroStats {
  totalLeads?: number;
  pendingTasks?: number;
  activeOffers?: number;
  unassignedLeads?: number;
}
interface HeroToday {
  overdueTasks?: number;
}

interface DashboardHeroProps {
  stats?: HeroStats;
  today?: HeroToday;
  isManager: boolean;
  firstName?: string;
}

/**
 * The dashboard's "what do I do now?" anchor — a single, role-aware primary
 * action at the top of the page, so no one lands on a wall of KPI zeros without
 * a next step:
 *  - brand-new workspace (no leads yet) → "start with your first lead"
 *  - work waiting → jump to the most urgent queue (overdue → unassigned → tasks)
 *  - all clear → a positive nudge back into the pipeline
 * Renders nothing while stats are still loading (KpiGrid shows the skeletons).
 */
export function DashboardHero({ stats, today, isManager, firstName }: DashboardHeroProps) {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();

  if (!stats) return null;

  const totalLeads = stats.totalLeads ?? 0;

  if (totalLeads === 0) {
    return (
      <EmptyState
        icon={<UserPlus className="h-6 w-6" />}
        title={t('dashboard.hero.emptyTitle', 'Start with your first lead')}
        description={t(
          'dashboard.hero.emptyDesc',
          'Add a lead to begin building your pipeline — everything else follows from here.',
        )}
        action={
          <Button onClick={() => navigate('/leads/new')}>
            {t('quickCreate.lead', 'New lead')}
          </Button>
        }
      />
    );
  }

  const overdue = today?.overdueTasks ?? 0;
  const unassigned = isManager ? stats.unassignedLeads ?? 0 : 0;
  const pending = stats.pendingTasks ?? 0;
  const offers = stats.activeOffers ?? 0;
  const waiting = overdue + unassigned + pending + offers;

  const primary =
    overdue > 0
      ? { to: '/tasks?tab=overdue', label: t('dashboard.hero.reviewOverdue', 'Review overdue tasks') }
      : unassigned > 0
        ? { to: '/leads?assignmentStatus=unassigned', label: t('dashboard.hero.reviewUnassigned', 'Assign leads') }
        : { to: '/leads', label: t('dashboard.hero.goToLeads', 'Go to your leads') };

  const greeting = firstName
    ? t('dashboard.hero.greetingNamed', { name: firstName, defaultValue: 'Hi {{name}}' })
    : t('dashboard.hero.greeting', 'Welcome back');

  const subtitle =
    waiting > 0
      ? t('dashboard.hero.waiting', { n: waiting, defaultValue: '{{n}} items need your attention today' })
      : t('dashboard.hero.clear', "You're all caught up — nice work.");

  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="font-display text-h3 text-foreground">{greeting}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <Button
        onClick={() => navigate(primary.to)}
        className="gap-1.5 self-start sm:self-auto"
      >
        {primary.label}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </Card>
  );
}
