import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { confirmPayment, listPayments, reissueCode, revokeActivation } from '@/api/platform';
import type { ActivationDelivery, PlatformPayment, WorkspaceStatus } from '@/api/types';
import { QueryState } from '@/components/QueryState';
import { WorkspaceStatusBadge } from '@/components/StatusBadges';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Textarea, PageHeader, toast } from '@/components/ui';
import { formatDateTime, formatMoney } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { PLATFORM_WORKSPACES_KEY } from './WorkspacesPage';
export const PLATFORM_PAYMENTS_KEY = ['platform','payments'] as const;

export function PaymentsPage() {
  const {t,i18n}=useTranslation(); const client=useQueryClient();
  const payments=useQuery({queryKey:PLATFORM_PAYMENTS_KEY,queryFn:listPayments});
  // Only component memory holds delivery. No mutation cache, query cache, storage or telemetry.
  const [delivery,setDelivery]=useState<(ActivationDelivery & {payment: string}) | null>(null);
  const [statuses,setStatuses]=useState<Record<string,WorkspaceStatus>>({});
  const [busy,setBusy]=useState(false); const [revoking,setRevoking]=useState<PlatformPayment|null>(null); const [reason,setReason]=useState('');
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true; return ()=>{mounted.current=false;};},[]);
  async function issue(row: PlatformPayment,reissue: boolean) {
    setDelivery(null); setBusy(true);
    try {
      const out=await (reissue ? reissueCode : confirmPayment)(row.workspace_id,row.payment_id);
      if(!mounted.current) return;
      // Explicitly copy only the safe projection into the cache.
      client.setQueryData<PlatformPayment[]>(PLATFORM_PAYMENTS_KEY,list=>list?.map(p=>p.payment_id===row.payment_id?{...p,entitlement:out.entitlement}:p));
      setStatuses(s=>({...s,[row.workspace_id]:out.workspace.status}));
      if(out.activation) setDelivery({...out.activation,payment:row.payment_id});
      void client.invalidateQueries({queryKey:PLATFORM_WORKSPACES_KEY});
    } catch(e) {if(mounted.current) toast.error(errorMessage(t,e));}
    finally {if(mounted.current) setBusy(false);}
  }
  async function revoke() {
    if(!revoking) return;
    setDelivery(null);setBusy(true);
    try {
      const out=await revokeActivation(revoking.workspace_id,reason.trim());
      if(!mounted.current) return;
      setStatuses(s=>({...s,[out.id]:out.status}));setRevoking(null);setReason('');
      await client.invalidateQueries({queryKey:PLATFORM_PAYMENTS_KEY});
      void client.invalidateQueries({queryKey:PLATFORM_WORKSPACES_KEY});
    } catch(e) {if(mounted.current) toast.error(errorMessage(t,e));}
    finally {if(mounted.current) setBusy(false);}
  }
  return <>
    <PageHeader title={t('platform.payments.title')} description={t('platform.payments.description')}/>
    <QueryState query={payments}>
      {payments.data?.length===0 && <p>{t('platform.payments.empty')}</p>}
      {payments.data?.map(row=><section key={row.payment_id} className="space-y-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-medium">{row.reference}</h2>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt>{t('platform.payments.workspace')}</dt><dd className="font-mono text-caption">{row.workspace_id}</dd></div>
          <div><dt>{t('platform.payments.amount')}</dt><dd>{formatMoney(row.amount_minor,row.currency,i18n.language)} · {row.currency}</dd></div>
          <div><dt>{t('platform.payments.paidAt')}</dt><dd>{formatDateTime(row.paid_at,i18n.language)}</dd></div>
          <div><dt>{t('platform.payments.state')}</dt><dd>{t(row.entitlement?.revoked_at?'platform.payments.revoked':row.entitlement?.activated_at?'platform.payments.activated':row.entitlement?'platform.payments.confirmed':'platform.payments.noGrant')}</dd></div>
        </dl>
        {statuses[row.workspace_id] && <WorkspaceStatusBadge status={statuses[row.workspace_id]} />}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={()=>void issue(row,false)}>{t('platform.payments.confirm')}</Button>
          <Button variant="outline" disabled={busy || !row.entitlement || !!row.entitlement.activated_at || !!row.entitlement.revoked_at} onClick={()=>void issue(row,true)}>{t('platform.payments.reissue')}</Button>
          <Button variant="outline" disabled={busy} onClick={()=>{setRevoking(row);setReason('');}}>{t('platform.payments.revoke')}</Button>
        </div>
        {delivery?.payment===row.payment_id && <div className="space-y-2 rounded-md border border-border p-4" role="status">
          <h3>{t('platform.payments.code')}</h3><output aria-label={t('platform.payments.code')} className="block font-mono text-h2">{delivery.code}</output>
          <p>{t('platform.payments.expires')}: {formatDateTime(delivery.expires_at,i18n.language)}</p>
          <p className="text-muted-foreground">{t('platform.payments.handoff')}</p>
        </div>}
      </section>)}
    </QueryState>
    <Dialog open={revoking!==null} onOpenChange={open=>{if(!open)setRevoking(null);}}><DialogContent>
      <DialogHeader><DialogTitle>{t('platform.payments.revoke')}</DialogTitle><DialogDescription>{t('platform.payments.reasonHelp')}</DialogDescription></DialogHeader>
      <label htmlFor="revoke-reason">{t('platform.workspaces.reason')}</label><Textarea id="revoke-reason" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/>
      <DialogFooter><Button disabled={busy||!reason.trim()} onClick={()=>void revoke()}>{t('platform.workspaces.confirm')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
