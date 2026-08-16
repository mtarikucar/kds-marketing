import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { listPendingApprovals } from '../../../features/marketing/api/growthBudget.service';
import { ApprovalQueue } from '../../../features/marketing/components/ApprovalQueue';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { CommandBar } from './CommandBar';
import { AgentActivity } from './AgentActivity';

interface FunnelStats {
  totalLeads?: number;
  pendingTasks?: number;
  unassignedLeads?: number;
  activeOffers?: number;
}

/**
 * The home screen.
 *
 * Jeeta is sold on one promise: describe your business, and it runs your
 * marketing without asking you to operate anything. The product had grown into
 * 101 routes and 51 menu entries — a full manual CRM where the agent was a
 * settings page — so the promise had no surface to live on. This is that
 * surface, and it is deliberately built from three things only:
 *
 *   1. What needs YOU. The approval queue, which the agent fills and which was
 *      previously reachable only through a tab on the ad-budget page.
 *   2. What it DID. The audit trail, so trust does not depend on asking.
 *   3. A command bar, so anything else is a sentence rather than a page hunt.
 *
 * Everything else in the product is still there and still routable; it is just
 * no longer the way you are expected to work. Resisting the urge to add a
 * fourth panel here is the feature.
 */
export default function CommandCenterPage() {
  const { t } = useTranslation('marketing');
  const user = useMarketingAuthStore((s) => s.user);

  const { data: stats } = useQuery<FunnelStats>({
    queryKey: ['marketing', 'dashboard', 'stats'],
    queryFn: () => marketingApi.get<FunnelStats>('/dashboard/stats').then((r: { data: FunnelStats }) => r.data),
  });

  // Only to size the heading — ApprovalQueue owns the list itself and shares
  // this query key, so the count and the cards can never disagree.
  const { data: approvals } = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: listPendingApprovals,
  });
  const waiting = approvals?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-2">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">
          {user?.firstName
            ? t('command.greeting', 'Merhaba {{name}}', { name: user.firstName })
            : t('command.greetingPlain', 'Merhaba')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('command.subtitle', 'Ne yapılması gerektiğini söyle, gerisini ben hallederim.')}
        </p>
      </header>

      <Card>
        <CardContent className="pt-5">
          <CommandBar />
        </CardContent>
      </Card>

      {/* Rendered only when something is actually waiting: a permanent empty
          "Approvals" box trains people to ignore the one place that must never
          be ignored. */}
      {waiting > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {t('command.waitingOnYou', 'Onayını bekliyor')}
              <Badge tone="warning">{waiting}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ApprovalQueue />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('command.whatIDid', 'Neler yaptım')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentActivity />
        </CardContent>
      </Card>

      {/* The pipeline in one line. Numbers are links, not a dashboard: the
          point is to notice something, then say what to do about it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-sm text-muted-foreground">
        <Link to="/leads" className="hover:text-foreground">
          {t('command.leads', '{{count}} lead', { count: stats?.totalLeads ?? 0 })}
        </Link>
        {(stats?.unassignedLeads ?? 0) > 0 && (
          <Link to="/leads?assignmentStatus=unassigned" className="hover:text-foreground">
            {t('command.unassigned', '{{count}} atanmamış', { count: stats?.unassignedLeads ?? 0 })}
          </Link>
        )}
        {(stats?.pendingTasks ?? 0) > 0 && (
          <Link to="/tasks" className="hover:text-foreground">
            {t('command.tasks', '{{count}} açık görev', { count: stats?.pendingTasks ?? 0 })}
          </Link>
        )}
        {/* The KPI board lost its sidebar entry to this page, so it has to be
            reachable from here or it is orphaned. */}
        <Link to="/dashboard" className="ml-auto hover:text-foreground">
          {t('command.fullDashboard', 'Tüm göstergeler')}
        </Link>
      </div>
    </div>
  );
}
