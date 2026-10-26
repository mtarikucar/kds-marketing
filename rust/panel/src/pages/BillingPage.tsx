import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { activateBilling, reportPayment, type ReportPayment } from '@/api/billing';
import { getWorkspace } from '@/api/workspace';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, Callout, Card, CardContent, Field, Input, PageHeader } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { billingStage, useBilling } from './billing/queries';

export function BillingPage() {
  const session = useSession();
  return <BillingForm key={session.data?.current_workspace} />;
}

function BillingForm() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const session = useSession();
  const billing = useBilling('billing');
  const workspace = useQuery({queryKey:['workspace',session.data?.current_workspace],queryFn:getWorkspace});
  const [amount, setAmount] = useState('');
  const [paidAt, setPaidAt] = useState('');
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
  const canReport = owner && data?.workspace_status !== 'suspended';
  const canActivate = owner && data?.workspace_status === 'pending_payment' && !!data.entitlement && !data.entitlement.revoked_at;

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
        const amountMinor = Number(amount);
        const instant = new Date(paidAt);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !paidAt || !Number.isFinite(instant.getTime()) || instant.getTime() > Date.now()) {
          setError(t('billing.invalidEvidence')); return;
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
    <QueryState query={billing}>{data && <Card><CardContent className="space-y-5 pt-6">
      <h2 className="text-h3">{t(`billing.stages.${billingStage(data)}`)}</h2>
      <dl className="space-y-3">
        <div><dt>{t('billing.price')}</dt><dd>{formatMoney(data.price_minor,data.price_currency,i18n.language)} · {data.price_currency}</dd></div>
        <div><dt>{t('billing.bank')}</dt><dd className="whitespace-pre-wrap">{data.bank_instructions}</dd></div>
      </dl>
      <Field label={t('billing.reference')}>{ids=><Input id={ids.id} readOnly value={data.payment_reference}/>}</Field>
      {data.payment?.confirmed && <p>{t('onboarding.paymentConfirmed')}</p>}
      {data.entitlement && <p>{t(data.entitlement.revoked_at?'billing.revoked':data.entitlement.source==='grandfathered'?'billing.grandfathered':'billing.paidEntitlement')}</p>}
      {!owner && <Callout tone="info">{t('billing.ownerOnly')}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}
      {canReport && (!data.entitlement || data.entitlement.revoked_at) && <form onSubmit={event=>void submit(event,false)} className="space-y-4" autoComplete="off">
        <Field label={t('billing.amount')}>{ids=><Input id={ids.id} type="number" min={1} step={1} required value={amount} onChange={event=>setAmount(event.target.value)}/>}</Field>
        <Field label={t('billing.paidAt')}>{ids=><Input id={ids.id} type="datetime-local" required value={paidAt} onChange={event=>setPaidAt(event.target.value)}/>}</Field>
        <Button type="submit" disabled={busy}>{t('billing.report')}</Button>
      </form>}
      {canActivate && <form onSubmit={event=>void submit(event,true)} className="space-y-4" autoComplete="off">
        <Field label={t('billing.code')}>{ids=><Input id={ids.id} type="password" autoComplete="new-password" spellCheck={false} maxLength={8} value={code} onChange={event=>setCode(event.target.value)}/>}</Field>
        <p className="text-sm text-muted-foreground">{t('billing.codeHelp')}</p>
        <Button type="submit" disabled={busy || code.length!==8}>{t('billing.activate')}</Button>
      </form>}
    </CardContent></Card>}</QueryState>
  </>;
}
