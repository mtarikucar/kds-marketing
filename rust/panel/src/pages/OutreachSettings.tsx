import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { setOutreachSettings } from '@/api/outreach';
import type { ContactChannel, OutreachSettingsInput, OutreachSettingsOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, PageHeader, Textarea, toast } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { useInFlight } from '@/lib/leads';
import { can, currentMembership } from '@/lib/roles';
import { useLeadsRefresh } from './LeadsShared';
import { LockNotice, useOutreachSettings } from './OutreachShared';

const isNumber = (s: string, min: number, max: number) => /^\d+$/.test(s) && Number(s) >= min && Number(s) <= max;

/** Sender identity, approval, warm-up, frequency and click tracking (`outreach.manage`). */
function GeneralForm({ settings, editable }: { settings: OutreachSettingsOut; editable: boolean }) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [company, setCompany] = useState(settings.sender_company);
  const [address, setAddress] = useState(settings.sender_address);
  const [privacy, setPrivacy] = useState(settings.privacy_notice_url);
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
      sender_company: company.trim(),
      sender_address: address.trim(),
      privacy_notice_url: privacy.trim(),
      requires_approval: approval,
      click_tracking_default: clicks,
      warmup: { enabled: warmupOn, start: Number(start), step: Number(step), max: Number(max) },
      frequency: { min_gap_days: Number(gap), max_per_30_days: Number(per30) },
    };
    guard((release) => save.mutate(input, { onSettled: release }));
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label={t('leads.settings.general')}>
      <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border p-4 sm:grid-cols-2" disabled={!editable}>
        <legend className="px-1 text-sm font-semibold">{t('leads.settings.identity')}</legend>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.company')}
          <Input value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.settings.address')}
          <Input value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          {t('leads.settings.privacy')}
          <Input type="url" value={privacy} onChange={(e) => setPrivacy(e.target.value)} />
        </label>
      </fieldset>
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

/** The channels the business-recipient basis may cover (`jt_outreach::B2B_BASIS_CHANNELS`), in the order offered. */
const B2B_CHANNELS: readonly ContactChannel[] = ['email', 'sms', 'whats_app', 'instagram_dm', 'messenger'];
const B2B_NAMES: Partial<Record<ContactChannel, string>> = { sms: 'SMS', whats_app: 'WhatsApp', instagram_dm: 'Instagram', messenger: 'Messenger' };
const b2bLabel = (language: string, channel: ContactChannel) =>
  language.startsWith('tr')
    ? `${B2B_NAMES[channel]} için işletme alıcısı dayanağını aç`
    : `Open the business-recipient basis for ${B2B_NAMES[channel]}`;

/**
 * The business-recipient basis: a human owner's act with the counsel's confirmation recorded in
 * the same save (spec §3.12, D17). Off by default; cold email to businesses stays locked until then.
 */
function B2bForm({ settings }: { settings: OutreachSettingsOut }) {
  const { t, i18n } = useTranslation();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [channels, setChannels] = useState<readonly ContactChannel[]>(settings.b2b_basis);
  const [lookup, setLookup] = useState(settings.require_iys_lookup);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: (input: OutreachSettingsInput) => setOutreachSettings(input),
    onSuccess: async () => {
      toast.success(t('leads.settings.saved'));
      setConfirmed(false);
      setNote('');
      await refresh();
    },
  });
  // Opening the basis, or turning the İYS lookup off, needs the acknowledgement in the same save.
  const widens = channels.some((c) => !settings.b2b_basis.includes(c)) || (!lookup && settings.require_iys_lookup);
  const ack = confirmed && note.trim().length > 0;
  const changed =
    channels.length !== settings.b2b_basis.length ||
    channels.some((c) => !settings.b2b_basis.includes(c)) ||
    lookup !== settings.require_iys_lookup;
  const valid = changed && (!widens || ack);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const input: OutreachSettingsInput = {
      b2b_basis: B2B_CHANNELS.filter((c) => channels.includes(c)),
      require_iys_lookup: lookup,
      ...(widens || ack ? { legal_ack: { counsel_confirmed: true, note: note.trim() } } : {}),
    };
    guard((release) => save.mutate(input, { onSettled: release }));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.settings.b2b.title')}</CardTitle>
        <CardDescription>{t('leads.settings.b2b.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('leads.settings.b2b.title')}>
          <Callout tone="warning">{t('leads.settings.b2b.legal')}</Callout>
          {settings.legal_ack && (
            <p className="text-sm text-muted-foreground">
              {t('leads.settings.b2b.recorded', { at: formatDateTime(settings.legal_ack.at, i18n.language) })}
              {` · ${settings.legal_ack.note}`}
            </p>
          )}
          {B2B_CHANNELS.map((channel) => (
            <label key={channel} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={channels.includes(channel)}
                onChange={(e) => setChannels((list) => (e.target.checked ? [...list, channel] : list.filter((c) => c !== channel)))}
              />
              {channel === 'email' ? t('leads.settings.b2b.email') : b2bLabel(i18n.language, channel)}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={lookup} onChange={(e) => setLookup(e.target.checked)} />
            {t('leads.settings.b2b.iys')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('leads.settings.b2b.counsel')}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.settings.b2b.note')}
            <Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
          {settings.b2b_basis.length > 0 && settings.b2b_channels_in_force.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('leads.settings.b2b.notInForce')}</p>
          )}
          <ErrorCallout error={save.error} />
          <div>
            <Button type="submit" disabled={!valid} loading={save.isPending}>
              {t('leads.settings.b2b.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** `/outreach/settings`: the outreach settings; the B2B basis section for owners only (spec §9). */
export function OutreachSettings() {
  const { t } = useTranslation();
  const session = useSession();
  const settings = useOutreachSettings();
  const manage = can(session.data, 'outreach.manage');
  const owner = currentMembership(session.data)?.role_key === 'owner' && manage;
  const s = settings.data;
  return (
    <>
      <PageHeader
        title={t('leads.settings.title')}
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
            <Card>
              <CardHeader>
                <CardTitle>{t('leads.settings.general')}</CardTitle>
                {!manage && <CardDescription>{t('leads.settings.readOnly')}</CardDescription>}
              </CardHeader>
              <CardContent>
                <GeneralForm key={JSON.stringify(s)} settings={s} editable={manage} />
              </CardContent>
            </Card>
            {owner && <B2bForm key={JSON.stringify([s.b2b_basis, s.require_iys_lookup, s.legal_ack])} settings={s} />}
          </div>
        )}
      </QueryState>
    </>
  );
}
