import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listCampaigns } from '@/api/outreach';
import { CAMPAIGN_STATUSES, type CampaignRow, type CampaignStatus } from '@/api/types';
import { QueryState } from '@/components/QueryState';
import { Button, DataTable, EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { selectClass } from './InboxShared';
import { useLeadsKey } from './LeadsShared';
import { CampaignStatusBadge, LockNotice, useOutreachSettings } from './OutreachShared';

/** `/outreach`: the campaigns with their status and what holds them (spec §9). */
export function OutreachPage() {
  const { t, i18n } = useTranslation();
  const key = useLeadsKey();
  const settings = useOutreachSettings();
  const [status, setStatus] = useState<CampaignStatus | ''>('');
  const campaigns = useQuery({
    queryKey: [...key, 'outreach', 'campaigns', status || 'all'],
    queryFn: () => listCampaigns({ status: status || undefined }),
  });
  const columns = useMemo<ColumnDef<CampaignRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('leads.outreach.columns.name'),
        accessorFn: (c) => c.name,
        cell: ({ row }) => (
          <Link to={`/outreach/${encodeURIComponent(row.original.id)}`} className="font-medium text-foreground hover:underline">
            {row.original.name}
          </Link>
        ),
      },
      {
        id: 'status',
        header: t('leads.outreach.columns.status'),
        accessorFn: (c) => c.status,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <CampaignStatusBadge status={row.original.status} />
            {row.original.pause_reason && (
              <span className="text-caption text-muted-foreground">{t(`leads.pauseReasons.${row.original.pause_reason}`)}</span>
            )}
          </span>
        ),
      },
      {
        id: 'steps',
        header: t('leads.outreach.columns.steps'),
        accessorFn: (c) => c.definition.steps.length,
      },
      {
        id: 'revision',
        header: t('leads.outreach.columns.revision'),
        accessorFn: (c) => c.revision,
      },
      {
        id: 'launched',
        header: t('leads.outreach.columns.launched'),
        accessorFn: (c) => c.launched_at ?? '',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {row.original.launched_at ? formatDateTime(row.original.launched_at, i18n.language) : '—'}
          </span>
        ),
      },
    ],
    [t, i18n.language],
  );
  return (
    <>
      <PageHeader
        title={t('leads.outreach.title')}
        description={t('leads.outreach.description')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/outreach/templates">{t('leads.outreach.templatesLink')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/outreach/settings">{t('leads.outreach.settingsLink')}</Link>
            </Button>
            <Button asChild>
              <Link to="/outreach/new">{t('leads.outreach.newCampaign')}</Link>
            </Button>
          </div>
        }
      />
      <LockNotice settings={settings.data} />
      <div className="rounded-lg border border-border bg-surface p-4">
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        {t('leads.outreach.statusFilter')}
        <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as CampaignStatus | '')}>
          <option value="">{t('leads.prospects.filters.all')}</option>
          {CAMPAIGN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`leads.campaignStatus.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4"><QueryState query={campaigns}>
        <DataTable
          columns={columns}
          data={campaigns.data?.items ?? []}
          emptyState={status ? (
            <EmptyState title={t('leads.filteredEmpty.title')} description={t('leads.filteredEmpty.body')}
              action={<Button variant="outline" onClick={() => setStatus('')}>{t('leads.filteredEmpty.clear')}</Button>} />
          ) : (
            <EmptyState icon={<img src="/brand/scenes/campaigns.svg" width="120" height="96" alt="" />}
              title={t('leads.outreach.empty')} description={t('leads.outreach.emptyBody')}
              action={<Button asChild><Link to="/outreach/new">{t('leads.outreach.newCampaign')}</Link></Button>} />
          )}
        />
      </QueryState></div>
      </div>
    </>
  );
}
