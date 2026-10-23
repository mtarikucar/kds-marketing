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
import { Badge, Button, Callout, Input, PageHeader } from '@/components/ui';
import { columnClass, selectClass, useInboxKey, useInboxMutation } from './InboxShared';

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
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">{t('inbox.commissions.filterState')}
            <select className={selectClass} value={state} onChange={e => setState(e.target.value as CommissionState | '')}>
              <option value="">{t('inbox.commissions.all')}</option>
              {(['no_payee', 'pending', 'approved', 'paid'] as const).map(s => <option key={s} value={s}>{t(`inbox.commissions.state.${s}`)}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('inbox.commissions.payee')}
            <select className={selectClass} value={payee} onChange={e => setPayee(e.target.value)}>
              <option value="">{t('inbox.commissions.all')}</option>
              {members.map(m => <option key={m.user_id} value={m.user_id!}>{m.display_name || m.email}</option>)}
            </select>
          </label>
        </div>
        <ErrorCallout error={approve.error || pay.error} />
        <QueryState query={rows}>
          {rows.data?.length === 0 && <p>{t('inbox.empty')}</p>}
          {rows.data?.map(row => <article key={row.id} data-testid={`commission-${row.id}`} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{formatMoney(row.amount_minor, row.currency, i18n.language)}</strong>
              <Badge>{t(`inbox.commissions.state.${row.state}`)}</Badge>
            </div>
            <p>{t('inbox.commissions.payee')}: {row.payee ? team.data?.find(m => m.user_id === row.payee)?.display_name || row.payee : t('inbox.commissions.unassigned')}</p>
            <p>{t('inbox.commissions.snapshotRate', { rate: row.rate_bp / 100 })}</p>
            {row.state === 'no_payee' && <p>{t('inbox.commissions.noPayeeHelp')}</p>}
            {decide && row.payee && row.state === 'pending' && <Button size="sm" loading={approve.isPending} disabled={pay.isPending} onClick={() => approve.mutate(row.id)}>{t('inbox.commissions.approve')}</Button>}
            {decide && row.payee && row.state === 'approved' && <Button size="sm" loading={pay.isPending} disabled={approve.isPending} onClick={() => pay.mutate(row.id)}>{t('inbox.commissions.pay')}</Button>}
          </article>)}
        </QueryState>
      </section>
      {manage && <form className={columnClass} aria-label={t('inbox.commissions.rates')} onSubmit={e => { e.preventDefault(); if (validRate) save.mutate(); }}>
        <h2 className="font-semibold">{t('inbox.commissions.rates')}</h2>
        <p className="text-sm text-muted-foreground">{t('inbox.commissions.rateHelp')}</p>
        <label className="text-sm">{t('inbox.commissions.rateTarget')}
          <select className={selectClass} value={rateUser} onChange={e => setRateUser(e.target.value)}>
            <option value="">{t('inbox.commissions.defaultRate')}</option>
            {members.map(m => <option key={m.user_id} value={m.user_id!}>{m.display_name || m.email}</option>)}
          </select>
        </label>
        <label className="text-sm">{t('inbox.commissions.rate')}
          <Input type="number" min={0} max={65535} step={1} value={rate} onChange={e => setRate(e.target.value)} />
        </label>
        <ErrorCallout error={save.error} />
        {save.isSuccess && <p role="status">{t('inbox.commissions.saved')}</p>}
        <Button type="submit" loading={save.isPending} disabled={!validRate}>{t('inbox.commissions.save')}</Button>
      </form>}
    </div>
  </>;
}
