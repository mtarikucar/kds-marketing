import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { listPendingApprovals } from '../../../features/marketing/api/growthBudget.service';
import { ApprovalQueue } from '../../../features/marketing/components/ApprovalQueue';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { CommandBar } from './CommandBar';
import { LeftColumn } from './LeftColumn';
import { useFailureCount } from './useFailureCount';

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
 *   2. What it DID / what is COMING. The left column's two tabs — the audit
 *      trail, so trust does not depend on asking, and the calendar.
 *   3. A command bar, so anything else is a sentence rather than a page hunt.
 *
 * Everything else in the product is still there and still routable; it is just
 * no longer the way you are expected to work. Resisting the urge to add a
 * fourth panel here is the feature — which is why the funnel counters that used
 * to sit at the bottom are gone (see the header link below). Two columns rather
 * than one stack, because the chat is a conversation you hold while reading the
 * calendar; scrolling one out of view to reach the other made them alternatives.
 */
export default function CommandCenterPage() {
  const { t } = useTranslation('marketing');
  const user = useMarketingAuthStore((s) => s.user);

  // Read here, not inside LeftColumn: the badge and the flow panel share one
  // query key and one selector (see useFailureCount), so the tab strip can
  // still speak while the flow tab itself is unmounted behind the calendar.
  const failureCount = useFailureCount();

  // Only to size the heading — ApprovalQueue owns the list itself and shares
  // this query key, so the count and the cards can never disagree.
  const { data: approvals } = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: listPendingApprovals,
  });
  const waiting = approvals?.length ?? 0;

  return (
    // `lg:h-full` and not a `100vh` calc: the layout's scroll container already
    // subtracts the header and its own padding, so the columns fill exactly
    // what is left. Below `lg` the height is dropped entirely and the two
    // sections stack — a 38/62 split on a phone is two unusable columns, and a
    // viewport-locked panel there would trap the calendar in ~200px of scroll.
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-3">
        <h1 className="text-2xl font-semibold text-foreground">
          {user?.firstName
            ? t('command.greeting', 'Merhaba {{name}}', { name: user.firstName })
            : t('command.greetingPlain', 'Merhaba')}
        </h1>
        {/* The KPI board lost its sidebar entry to this page, so it has to be
            reachable from here or it is orphaned. The per-metric counters that
            used to carry this link were the fourth panel this screen refuses to
            have: /leads and /tasks are one rail click (and one palette keystroke)
            away, so the counters bought a row of chrome and no decision. */}
        <Link to="/dashboard" className="ms-auto text-sm text-muted-foreground hover:text-foreground">
          {t('command.fullDashboard', 'Tüm göstergeler')}
        </Link>
        <p className="w-full text-sm text-muted-foreground">
          {t('command.subtitle', 'Ne yapılması gerektiğini söyle, gerisini ben hallederim.')}
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <section data-testid="home-left" className="min-h-0 lg:basis-[38%] lg:shrink-0">
          <Card className="h-full">
            <CardContent className="h-full min-h-0 pt-4">
              <LeftColumn failureCount={failureCount} />
            </CardContent>
          </Card>
        </section>

        <section
          data-testid="home-chat"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4"
        >
          <Card className="min-h-0 lg:flex-1">
            {/* The transcript grows without bound and CommandBar is not
                height-aware, so the overflow is owned here — otherwise a long
                conversation pushes the approval queue off the screen. */}
            <CardContent className="h-full min-h-0 overflow-y-auto pt-5">
              <CommandBar />
            </CardContent>
          </Card>

          {/* Rendered only when something is actually waiting: a permanent empty
              "Approvals" box trains people to ignore the one place that must never
              be ignored. */}
          {waiting > 0 && (
            <Card className="shrink-0">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  {t('command.waitingOnYou', 'Onayını bekliyor')}
                  <Badge tone="warning">{waiting}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="max-h-[40vh] overflow-y-auto">
                <ApprovalQueue />
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
