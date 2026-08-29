import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Target } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { BadgeProps } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { formatMoney } from '../../../lib/money';
import {
  listOpportunities,
  listPipelines,
  type Opportunity,
} from '../../../features/marketing/api/opportunities.service';

const statusTone: Record<string, BadgeProps['tone']> = {
  OPEN: 'info',
  WON: 'success',
  LOST: 'danger',
  ABANDONED: 'neutral',
};

interface SalesTabProps {
  leadId: string;
  fmtDate: (d: string | Date | null | undefined) => string;
}

/**
 * "Satış" — the deals open against THIS contact, each shown at the stage it
 * actually sits in.
 *
 * Two queries, deliberately asymmetric in how their failures are treated:
 *
 *  - the opportunities list is the panel. Its failure is the panel's failure,
 *    and it gets the error branch. `leadId` is the whole correctness of the
 *    request: drop it and `GET /opportunities` answers with the WORKSPACE's
 *    deals, which renders as a completely normal — and completely wrong —
 *    list under one person's name.
 *  - the pipelines list only NAMES the stage (the list endpoint returns a bare
 *    `stageId`). Failing the whole tab because a label could not be resolved
 *    would hide real deals over a cosmetic gap, so an unresolved stage is
 *    labelled as unknown rather than left blank — "we could not name it" and
 *    "this deal has no stage" must not look the same.
 */
export default function SalesTab({ leadId, fmtDate }: SalesTabProps) {
  const { t } = useTranslation('marketing');

  const opportunitiesQuery = useQuery({
    queryKey: ['marketing', 'opportunities', 'lead', leadId],
    queryFn: () => listOpportunities({ leadId }),
  });

  const pipelinesQuery = useQuery({
    queryKey: ['marketing', 'pipelines'],
    queryFn: listPipelines,
    staleTime: 60_000,
  });

  // stageId → stage name, across every pipeline (a lead's deals need not all
  // live in the same one).
  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pipelinesQuery.data ?? []) {
      for (const s of p.stages ?? []) map.set(s.id, s.name);
    }
    return map;
  }, [pipelinesQuery.data]);

  const opportunities: Opportunity[] = opportunitiesQuery.data?.data ?? [];

  // The board is the only opportunity surface in this app — there is no
  // /opportunities/:id route — so "open this deal" is the board deep-linked to
  // it. The pipeline rides along because the board renders ONE pipeline at a
  // time: without it a deal outside the default pipeline is simply absent from
  // the board its own link opened.
  const dealHref = (o: Opportunity) =>
    `/opportunities?deal=${encodeURIComponent(o.id)}&pipelineId=${encodeURIComponent(o.pipelineId)}`;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('leadDetail.tabs.sales', 'Satış')}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryStateBoundary
          isLoading={opportunitiesQuery.isLoading}
          isError={opportunitiesQuery.isError}
          onRetry={() => opportunitiesQuery.refetch()}
          errorMessage={t('leadDetail.sales.failed', 'Fırsatlar yüklenemedi.')}
        >
          {opportunities.length === 0 ? (
            <EmptyState
              icon={<Target className="h-5 w-5" />}
              title={t('leadDetail.sales.empty.title', 'Bu kişi için henüz fırsat yok')}
              description={t(
                'leadDetail.sales.empty.desc',
                'Bir fırsat açtığında kişiyi hattında takip eder, aşamasını burada görürsün.',
              )}
              action={
                // The board's OWN create dialog, carrying this lead — not a
                // second creation path. `?create=1` is the app-wide deep-link
                // convention (useCreateParam); `leadId` is what makes the deal
                // land on this record instead of floating free.
                <Link
                  to={`/opportunities?create=1&leadId=${encodeURIComponent(leadId)}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {t('leadDetail.sales.newDeal', 'Bu kişi için fırsat oluştur')}
                </Link>
              }
            />
          ) : (
            <ul className="space-y-2">
              {opportunities.map((o) => (
                <li key={o.id}>
                  <Link
                    to={dealHref(o)}
                    data-testid={`opportunity-${o.id}`}
                    className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 hover:bg-surface-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{o.name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded bg-surface-muted px-1.5 py-0.5">
                          {stageNameById.get(o.stageId) ??
                            t('leadDetail.sales.unknownStage', 'Bilinmeyen aşama')}
                        </span>
                        {o.expectedCloseDate && <span>{fmtDate(o.expectedCloseDate)}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-sm font-medium text-foreground">
                        {formatMoney(o.value, o.currency)}
                      </span>
                      <Badge tone={statusTone[o.status] ?? 'neutral'} size="sm">
                        {o.status}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryStateBoundary>
      </CardContent>
    </Card>
  );
}
