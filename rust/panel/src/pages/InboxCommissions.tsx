import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import { listTeam } from '@/api/team';
import type { CommissionState } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can, isOwnerOrManager } from '@/lib/roles';
import { formatMoney } from '@/lib/format';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Badge, Button, Callout, EmptyState, Input, PageHeader } from '@/components/ui';
import { columnClass, selectClass, useInboxKey, useInboxMutation, useMemberName } from './InboxShared';

export function InboxCommissions() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const key = useInboxKey();
  const allowed = can(session.data, 'inbox.work');
  const manage = can(session.data, 'inbox.manage');
  const decide = manage && isOwnerOrManager(session.data);
  const [state, setState] = useState<CommissionState | ''>('');
  const [payee, setPayee] = useState('');
  const [rateUser, setRateUser] = useState('');
  const [rate, setRate] = useState('');
  const rows = useQuery({
    queryKey: [...key, 'commissions', state, payee],
    queryFn: () => api.listCommissions(state || undefined, payee || undefined),
    enabled: allowed,
  });
  const team = useQuery({
    queryKey: [...key, 'team'],
    queryFn: listTeam,
    enabled: allowed && can(session.data, 'workspace.read'),
  });
  const members = team.data?.filter(m => m.status === 'active' && m.user_id) ?? [];
  const memberName = useMemberName();
  const approve = useInboxMutation(api.approveCommission);
  const pay = useInboxMutation(api.payCommission);
  const save = useInboxMutation(() => api.setCommissionRate({ user_id: rateUser || null, rate_bp: Number(rate) }));
  const validRate = rate !== '' && Number.isInteger(Number(rate)) && Number(rate) >= 0 && Number(rate) <= 65535;
  if (session.isPending) return <QueryState query={session} />;
  if (!allowed) return <Callout tone="warning">{t('errors.missingPermission', { permission: t('permissions.inbox.work') })}</Callout>;
  return <>
    <PageHeader title={t('inbox.commissions.title')} description={t('inbox.commissions.description')}
      actions={<Button asChild variant="outline"><Link to="/inbox">{t('inbox.title')}</Link></Button>} />
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className={columnClass} aria-label={t('inbox.commissions.title')}>
        <div className="grid gap-4 rounded-lg bg-surface-muted p-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-2 text-sm">{t('inbox.commissions.filterState')}
            <select className={selectClass} value={state} onChange={e => setState(e.target.value as CommissionState | '')}>
              <option value="">{t('inbox.commissions.all')}</option>
              {(['no_payee', 'pending', 'approved', 'paid'] as const).map(s => <option key={s} value={s}>{t(`inbox.commissions.state.${s}`)}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">{t('inbox.commissions.payee')}
            <select className={selectClass} value={payee} onChange={e => setPayee(e.target.value)}>
              <option value="">{t('inbox.commissions.all')}</option>
              {members.map(m => <option key={m.user_id} value={m.user_id!}>{m.display_name || m.email}</option>)}
            </select>
          </label>
        </div>
        <QueryState query={team} />
        <ErrorCallout error={approve.error || pay.error} />
        <QueryState query={rows}>
          {rows.data?.length === 0 && <EmptyState className="border-0 py-8" title={t('inbox.commissions.empty')} description={t('inbox.commissions.emptyBody')} />}
          {rows.data?.map(row => <article key={row.id} data-testid={`commission-${row.id}`} className="flex min-w-0 flex-col items-start gap-3 border-b border-border px-2 py-5 text-sm last:border-0">
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <strong className="font-display text-h2 tabular-nums">{formatMoney(row.amount_minor, row.currency, i18n.language)}</strong>
              <Badge tone={row.state === 'paid' ? 'success' : row.state === 'approved' ? 'info' : row.state === 'no_payee' ? 'warning' : 'neutral'}>{t(`inbox.commissions.state.${row.state}`)}</Badge>
            </div>
            <p>{t('inbox.commissions.payee')}: {row.payee ? memberName(row.payee) : t('inbox.commissions.unassigned')}</p>
            <p className="text-caption text-muted-foreground">{t('inbox.commissions.snapshotRate', { rate: row.rate_bp / 100 })}</p>
            {row.state === 'no_payee' && <p className="rounded-md border-l-2 border-warning bg-warning-subtle px-3 py-2">{t('inbox.commissions.noPayeeHelp')}</p>}
            {decide && row.payee && row.state === 'pending' && <Button size="sm" loading={approve.isPending} disabled={pay.isPending} onClick={() => approve.mutate(row.id)}>{t('inbox.commissions.approve')}</Button>}
            {decide && row.payee && row.state === 'approved' && <Button size="sm" loading={pay.isPending} disabled={approve.isPending} onClick={() => pay.mutate(row.id)}>{t('inbox.commissions.pay')}</Button>}
          </article>)}
        </QueryState>
      </section>
      {manage && <form className={`${columnClass} lg:sticky lg:top-4`} aria-label={t('inbox.commissions.rates')} onSubmit={e => { e.preventDefault(); if (validRate) save.mutate(); }}>
        <h2 className="font-display text-h3">{t('inbox.commissions.rates')}</h2>
        <p className="text-sm text-muted-foreground">{t('inbox.commissions.rateHelp')}</p>
        <label className="flex min-w-0 flex-col gap-2 text-sm">{t('inbox.commissions.rateTarget')}
          <select className={selectClass} value={rateUser} onChange={e => setRateUser(e.target.value)}>
            <option value="">{t('inbox.commissions.defaultRate')}</option>
            {members.map(m => <option key={m.user_id} value={m.user_id!}>{m.display_name || m.email}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-2 text-sm">{t('inbox.commissions.rate')}
          <Input type="number" min={0} max={65535} step={1} value={rate} onChange={e => setRate(e.target.value)} />
        </label>
        <ErrorCallout error={save.error} />
        {save.isSuccess && <p role="status">{t('inbox.commissions.saved')}</p>}
        <Button type="submit" loading={save.isPending} disabled={!validRate}>{t('inbox.commissions.save')}</Button>
      </form>}
    </div>
  </>;
}
