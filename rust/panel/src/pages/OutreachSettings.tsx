import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { setOutreachSettings } from '@/api/outreach';
import type { OutreachSettingsInput, OutreachSettingsOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, PageHeader, toast } from '@/components/ui';
import { useInFlight } from '@/lib/leads';
import { can } from '@/lib/roles';
import { useLeadsRefresh } from './LeadsShared';
import { LockNotice, useOutreachSettings } from './OutreachShared';

const isNumber = (s: string, min: number, max: number) => /^\d+$/.test(s) && Number(s) >= min && Number(s) <= max;

/**
 * What only the campaigns use (`outreach.manage`): approval, click tracking, warm-up and
 * frequency. The sender details and the business basis every email needs live with email
 * (`/settings/email`).
 */
function GeneralForm({ settings, editable }: { settings: OutreachSettingsOut; editable: boolean }) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [approval, setApproval] = useState(settings.requires_approval);
  const [clicks, setClicks] = useState(settings.click_tracking_default);
  const [warmupOn, setWarmupOn] = useState(settings.warmup.enabled);
  const [start, setStart] = useState(String(settings.warmup.start));
  const [step, setStep] = useState(String(settings.warmup.step));
  const [max, setMax] = useState(String(settings.warmup.max));
  const [gap, setGap] = useState(String(settings.frequency.min_gap_days));
  const [per30, setPer30] = useState(String(settings.frequency.max_per_30_days));
  const save = useMutation({
    mutationFn: (input: OutreachSettingsInput) => setOutreachSettings(input),
    onSuccess: async () => {
      toast.success(t('leads.settings.saved'));
      await refresh();
    },
  });
  const valid =
    isNumber(start, 1, 500) && isNumber(step, 0, 100) && isNumber(max, 1, 500) && isNumber(gap, 0, 30) && isNumber(per30, 1, 30);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !editable) return;
    const input: OutreachSettingsInput = {
      requires_approval: approval,
      click_tracking_default: clicks,
      warmup: { enabled: warmupOn, start: Number(start), step: Number(step), max: Number(max) },
      frequency: { min_gap_days: Number(gap), max_per_30_days: Number(per30) },
    };
    guard((release) => save.mutate(input, { onSettled: release }));
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label={t('leads.settings.general')}>
      <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4 text-sm" disabled={!editable}>
        <legend className="px-1 font-semibold">{t('leads.settings.sending')}</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
          {t('leads.settings.requiresApproval')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={clicks} onChange={(e) => setClicks(e.target.checked)} />
          {t('leads.settings.clickTracking')}
        </label>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border p-4 sm:grid-cols-4" disabled={!editable}>
        <legend className="px-1 text-sm font-semibold">{t('leads.settings.warmup')}</legend>
        <label className="flex items-center gap-2 text-sm sm:col-span-4">
          <input type="checkbox" checked={warmupOn} onChange={(e) => setWarmupOn(e.target.checked)} />
          {t('leads.settings.warmupOn')}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.warmupStart')}
          <Input type="number" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.warmupStep')}
          <Input type="number" value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.warmupMax')}
          <Input type="number" value={max} onChange={(e) => setMax(e.target.value)} />
        </label>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border p-4 sm:grid-cols-2" disabled={!editable}>
        <legend className="px-1 text-sm font-semibold">{t('leads.settings.frequency')}</legend>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.minGap')}
          <Input type="number" value={gap} onChange={(e) => setGap(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.per30')}
          <Input type="number" value={per30} onChange={(e) => setPer30(e.target.value)} />
        </label>
      </fieldset>
      <ErrorCallout error={save.error} />
      {editable && (
        <div>
          <Button type="submit" disabled={!valid} loading={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * `/outreach/settings`: what only the campaigns use. The sender details and the business basis
 * belong to email and are entered on `/settings/email` (or inline, where an email is written).
 */
export function OutreachSettings() {
  const { t } = useTranslation();
  const session = useSession();
  const settings = useOutreachSettings();
  const manage = can(session.data, 'outreach.manage');
  const s = settings.data;
  return (
    <>
      <PageHeader
        title={t('leads.settings.campaignTitle')}
        description={t('leads.settings.description')}
        actions={
          <Button asChild variant="outline">
            <Link to="/outreach">{t('leads.outreach.title')}</Link>
          </Button>
        }
      />
      <LockNotice settings={s} />
      <QueryState query={settings}>
        {s && (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              <Link to="/settings/email" className="font-medium text-primary hover:underline">{t('email.senderLink')}</Link>
            </p>
            <Card>
              <CardHeader>
                <CardTitle>{t('leads.settings.general')}</CardTitle>
                {!manage && <CardDescription>{t('leads.settings.readOnly')}</CardDescription>}
              </CardHeader>
              <CardContent>
                <GeneralForm key={JSON.stringify(s)} settings={s} editable={manage} />
              </CardContent>
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}
