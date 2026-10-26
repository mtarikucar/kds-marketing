import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getHealth } from '@/api/ops';
import { resetOperatorPassword } from '@/api/platform';
import { QueryState } from '@/components/QueryState';
import { Button, Input, PageHeader, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
export function HealthPage() {
  const {t,i18n}=useTranslation();const health=useQuery({queryKey:['platform','health'],queryFn:getHealth});
  const [operator,setOperator]=useState('');const [password,setPassword]=useState('');const [busy,setBusy]=useState(false);
  const h=health.data;
  const date=(value:string|null)=>formatDateTime(value,i18n.language)||t('platform.health.unknown');
  async function reset() {
    setBusy(true);const value=password;setPassword('');
    try{await resetOperatorPassword(operator.trim(),value);toast.success(t('platform.health.resetDone'));}
    catch(e){toast.error(errorMessage(t,e));}finally{setBusy(false);}
  }
  return <>
    <PageHeader title={t('platform.health.title')} description={t('platform.health.description')}/>
    <QueryState query={health}>{h && <>
      <dl className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-3">
        {(['database','files','disk','connectors_state'] as const).map(k=><div key={k}><dt>{t(`platform.health.${k}`)}</dt><dd>{t(`platform.health.${h[k]}`)}</dd></div>)}
        <div><dt>{t('platform.health.boot')}</dt><dd>{t(h.boot_complete?'platform.health.ok':'platform.health.degraded')}</dd></div>
        <div><dt>{t('platform.health.diskBytes')}</dt><dd>{h.disk_available_bytes??t('platform.health.unknown')}</dd></div>
        <div><dt>{t('platform.health.pool')}</dt><dd>{h.database_pool_idle} / {h.database_pool_size}</dd></div>
        <div><dt>{t('platform.health.observed')}</dt><dd>{date(h.observed_at)}</dd></div>
        <div><dt>{t('platform.health.started')}</dt><dd>{date(h.process_started_at)}</dd></div>
      </dl>
      <p>{t('platform.health.history')}</p>
      <section><h2>{t('platform.health.jobs')}</h2>{h.jobs.map(j=><p key={j.name}>{j.name} · {date(j.last_success_at)} · {t('platform.health.failures')}: {j.failed_total}</p>)}</section>
      <section><h2>{t('platform.health.connectors')}</h2>{h.connectors.map(c=><p key={`${c.workspace_id}:${c.kind_key}`}>{c.workspace_id} · {c.kind_key} · {t('platform.health.reconnect')}: {c.reconnect_required} · {date(c.expires_before)}</p>)}</section>
      <section><h2>{t('platform.health.webhooks')}</h2><p>{t('platform.health.accepted')}: {h.webhooks.accepted} · {t('platform.health.unrouted')}: {h.webhooks.unrouted} · {t('platform.health.unresolved')}: {h.webhooks.unresolved}</p></section>
      <section><h2>{t('platform.health.backup')}</h2><p>{t(`platform.health.${h.backup.backup_state}`)} · {date(h.backup.last_backup_at)}</p><p>WAL: {t(`platform.health.${h.backup.wal_state}`)} · {date(h.backup.last_wal_archive_at)}</p></section>
    </>}</QueryState>
    <form className="max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5" onSubmit={e=>{e.preventDefault();void reset();}}>
      <h2>{t('platform.health.reset')}</h2><p>{t('platform.health.resetHelp')}</p>
      <label htmlFor="operator-id">{t('platform.health.operator')}</label><Input id="operator-id" required value={operator} onChange={e=>setOperator(e.target.value)} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"/>
      <label htmlFor="operator-password">{t('platform.health.password')}</label><Input id="operator-password" type="password" autoComplete="new-password" required value={password} onChange={e=>setPassword(e.target.value)}/>
      <Button type="submit" disabled={busy||!operator.trim()||Array.from(password).length<12}>{t('platform.health.reset')}</Button>
    </form>
  </>;
}
