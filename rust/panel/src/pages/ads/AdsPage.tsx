import { useSearchParams } from 'react-router-dom';
import { CampaignQueue } from './CampaignQueue';
import { CampaignPage } from './CampaignPage';
import { Button } from '@/components/ui';
import { ModuleStatusLine } from '@/components/ModuleStatusLine';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { EmptyState } from '@/components/ui';
import { can } from '@/lib/roles';
import { StudioReadStatus, useOverviewWindow, useStudioKey } from '../StudioShared';
import { PaidActions } from './PaidActions';
import { PendingBudgetMoves } from './PendingBudgetMoves';

export function AdsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const legacy = params.get('tab') === 'external';
  const campaign = params.get('campaign');
  const key = useStudioKey();
  const allowed = can(session.data, 'ads.work');
  const manage = can(session.data, 'ads.manage');
  const query: api.Query = { ...useOverviewWindow(), lane: 'paid' };
  const overview = useQuery({ queryKey: [...key, 'overview', query], queryFn: () => api.overview(query), enabled: allowed && legacy, refetchInterval: 60_000 });
  const data = overview.data;
  return <div className="space-y-6">
    <WorkspaceHeader title={t('modulePages.ads')} />
    {!allowed ? <p role="alert">{t('studio.forbidden')}</p> : <>
      <ModuleStatusLine module="ads" />
      {campaign ? <CampaignPage key={campaign} id={campaign} manage={manage} /> : <>
      <nav className="flex flex-wrap gap-2" aria-label={t('modulePages.ads')}>
        <Button variant={legacy ? 'ghost' : 'secondary'} aria-pressed={!legacy} onClick={() => setParams({})}>{t('adCampaigns.queue')}</Button>
        <Button variant={legacy ? 'secondary' : 'ghost'} aria-pressed={legacy} className="h-auto min-h-9 whitespace-normal py-2 text-start" onClick={() => setParams({ tab: 'external' })}>{t('adCampaigns.legacy')}</Button>
      </nav>
      {!legacy ? <CampaignQueue manage={manage} /> : <>
      <StudioReadStatus query={overview} />
      {data && <>
        {data.lane_support.paid.visible ? <>
          <PaidActions data={data} manage={manage} />

        </> : <EmptyState title={t('modulePages.ads')} description={t('modulePages.paidUnavailable')} />}
        <PendingBudgetMoves data={data} manage={manage} />
      </>}
      </>}
      </>}
    </>}
  </div>;
}
