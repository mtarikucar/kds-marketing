import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { activateBilling, reportPayment, type ReportPayment } from '@/api/billing';
import { getWorkspace } from '@/api/workspace';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { CopyField } from '@/components/CopyField';
import { MoneyInput } from '@/components/forms';
import { Button, Callout, Card, CardContent, Field, Input, PageHeader } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import { billingStage, useBilling } from './billing/queries';
import { useEntryCopy } from './entryCopy';

/** `date` as a `datetime-local` value (`2026-10-26T15:04`) in the browser's own timezone. */
function localMinute(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function BillingPage() {
  const session = useSession();
  return <BillingForm key={session.data?.current_workspace} />;
}

function BillingForm() {
  const { t, i18n } = useTranslation();
  const copy = useEntryCopy();
  const client = useQueryClient();
  const session = useSession();
  const billing = useBilling('billing');
  const workspace = useQuery({queryKey:['workspace',session.data?.current_workspace],queryFn:getWorkspace});
  // Prefilled with the configured price and the current minute; both stay editable evidence.
  const [amount, setAmount] = useState<number | null>(null);
  const [paidAt, setPaidAt] = useState(() => localMinute(new Date()));
  const prefilled = useRef(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const controller = useRef<AbortController>();
  // A retry of unchanged evidence reuses its request key; nothing is persisted.
  const lastReport = useRef<ReportPayment>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); lastReport.current = undefined; };
  }, []);
  const owner = workspace.data?.my_role === 'owner' && workspace.data.my_permissions.includes('team.manage');
  const data = billing.data;
  useEffect(() => {
    if (data && !prefilled.current) { prefilled.current = true; setAmount(data.price_minor); }
  }, [data]);
  const canReport = owner && data?.workspace_status !== 'suspended';
  const canActivate = owner && data?.workspace_status === 'pending_payment' && !!data.entitlement && !data.entitlement.revoked_at;
  const stage = data ? billingStage(data) : null;

  async function submit(event: FormEvent, activation: boolean) {
    event.preventDefault();
    if (!data || busy || (activation ? !canActivate : !canReport)) return;
    setBusy(true); setError(null);
    controller.current = new AbortController();
    try {
      if (activation) {
        const submitted = code; setCode('');
        // Discard the reference-bearing response; refetch only while this page still exists.
        await activateBilling(submitted, controller.current.signal);
      } else {
        const amountMinor = amount;
        const instant = new Date(paidAt);
        if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
          setError(t('billing.invalidAmount')); return;
        }
        if (!paidAt || !Number.isFinite(instant.getTime()) || instant.getTime() > Date.now()) {
          setError(t('billing.invalidPaidAt')); return;
        }
        const evidence = {reference:data.payment_reference,amount_minor:amountMinor,paid_at:instant.toISOString()};
        const previous = lastReport.current;
        if (!previous || previous.reference !== evidence.reference || previous.amount_minor !== evidence.amount_minor || previous.paid_at !== evidence.paid_at) {
          lastReport.current = {...evidence,request_key:crypto.randomUUID()};
        }
        await reportPayment(lastReport.current!, controller.current.signal);
      }
      if (!mounted.current) return;
      await billing.refetch();
      if (!mounted.current) return;
      // Status and role are reread; activation does not approve strategy or connect an agent.
      void client.invalidateQueries({queryKey:['workspace']});
      void client.invalidateQueries({queryKey:['session']});
    } catch (failure) {
      if (mounted.current) setError(errorMessage(t, failure));
    } finally { if (mounted.current) setBusy(false); }
  }

  return <>
    <PageHeader title={t('billing.title')} description={t('billing.description')} />
    <Link to="/onboarding" className="text-primary underline">{t('onboarding.title')}</Link>
    <QueryState query={workspace} />
    <QueryState query={billing}>{data && <Card className="max-w-3xl rounded-none border-0 border-t border-border bg-transparent"><CardContent className="space-y-6 px-0 pb-0 pt-6">
      <h2 className="font-display text-h3">{t(`billing.stages.${billingStage(data)}`)}</h2>
      <p className="max-w-xl text-sm leading-6 text-muted-foreground">{copy(stage==='active'?'billingActive':stage==='suspended'?'billingSuspended':stage==='activation'?'billingActivation':stage==='approval'?'billingApproval':'billingPending')}</p>
      <details open={stage==='pending_payment'} className="group border-y border-border py-4">
      <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{copy('transferDetails')}</summary>
      <dl className="grid gap-5 border-y border-border py-5 sm:grid-cols-2">
        <div><dt className="text-caption text-muted-foreground">{t('billing.price')}</dt><dd className="mt-1 font-medium tabular-nums">{formatMoney(data.price_minor,data.price_currency,i18n.language)} · {data.price_currency}</dd></div>
        <div><dt className="text-caption text-muted-foreground">{t('billing.bank')}</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6">{data.bank_instructions}</dd></div>
      </dl>
      <div className="mt-4"><CopyField label={t('billing.reference')} value={data.payment_reference}/></div>
      </details>
      {data.payment && !data.payment.confirmed && <Callout tone="success">{t('billing.reported',{amount:formatMoney(data.payment.amount_minor,data.payment.currency,i18n.language),paidAt:formatDateTime(data.payment.paid_at,i18n.language)})}</Callout>}
      {data.payment?.confirmed && <p>{t('onboarding.paymentConfirmed')}</p>}
      {data.entitlement && <p>{t(data.entitlement.revoked_at?'billing.revoked':data.entitlement.source==='grandfathered'?'billing.grandfathered':'billing.paidEntitlement')}</p>}
      {!owner && <Callout tone="info">{t('billing.ownerOnly')}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}
      {canReport && (!data.entitlement || data.entitlement.revoked_at) && <details open={!data.payment || !!error} className="border-t border-border pt-5">
        <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{data.payment?copy('reportDetails'):copy('reportSection')}</summary>
        <form onSubmit={event=>void submit(event,false)} className="mt-4 max-w-md space-y-4" autoComplete="off" noValidate>
        <p className="text-sm leading-6 text-muted-foreground">{copy('reportHelp')}</p>
        <Field label={t('billing.amount',{currency:data.price_currency})} hint={t('billing.amountHint',{price:formatMoney(data.price_minor,data.price_currency,i18n.language)})}>{ids=><MoneyInput id={ids.id} describedBy={ids.describedBy} currency={data.price_currency} minor={amount} onChange={setAmount} required/>}</Field>
        <Field label={t('billing.paidAt')}>{ids=><Input id={ids.id} type="datetime-local" required max={localMinute(new Date())} value={paidAt} onChange={event=>setPaidAt(event.target.value)}/>}</Field>
        <Button type="submit" disabled={busy}>{t('billing.report')}</Button>
      </form></details>}
      {canActivate && <form onSubmit={event=>void submit(event,true)} className="max-w-md space-y-4 border-t border-border pt-5" autoComplete="off">
        <Field label={t('billing.code')}>{ids=><Input id={ids.id} type="password" autoComplete="new-password" spellCheck={false} maxLength={8} value={code} onChange={event=>setCode(event.target.value)}/>}</Field>
        <p className="text-sm text-muted-foreground">{t('billing.codeHelp')}</p>
        <Button type="submit" disabled={busy || code.length!==8}>{t('billing.activate')}</Button>
      </form>}
    </CardContent></Card>}</QueryState>
  </>;
}
