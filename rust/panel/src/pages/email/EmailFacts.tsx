import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getEmailSettings, setEmailSettings } from '@/api/inbox';
import type { ContactChannel, EmailSettingsInput, EmailSettingsOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Textarea, toast } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { useInFlight } from '@/lib/leads';
import { can, currentMembership } from '@/lib/roles';

// The email facts every commercial email needs (`inbox.email_settings_*`): the sender identity
// of its footer and the business-recipient basis. They belong to email, not to the campaigns:
// the same stored facts the campaigns read, reached without the campaigns module or an outreach
// permission. Used inline by the "Mesaj gönder" dialog and by `/settings/email`.

export function useEmailSettingsKey() {
  const session = useSession();
  return ['email-settings', session.data?.current_workspace] as const;
}

/** The email facts; refused (no `inbox.work`) leaves the server to decide at send. */
export function useEmailSettings() {
  const key = useEmailSettingsKey();
  return useQuery({ queryKey: key, queryFn: getEmailSettings, retry: false });
}

/** Saves email facts and puts the answer in place, so whatever waited on them goes on at once. */
function useSaveEmailSettings(onSaved?: (out: EmailSettingsOut) => void) {
  const client = useQueryClient();
  const key = useEmailSettingsKey();
  const session = useSession();
  return useMutation({
    mutationFn: (input: EmailSettingsInput) => setEmailSettings(input),
    onSuccess: async (out) => {
      client.setQueryData(key, out);
      onSaved?.(out);
      // The campaigns read the same facts.
      await client.invalidateQueries({ queryKey: ['leads', session.data?.current_workspace] });
    },
  });
}

/** Whether the person may open the business basis: a human owner (the server checks again). */
export function useMayOpenBasis(): boolean {
  const session = useSession();
  return currentMembership(session.data)?.role_key === 'owner' && can(session.data, 'inbox.manage');
}

type SenderField = 'sender_company' | 'sender_address' | 'privacy_notice_url';
const SENDER_FIELDS: readonly SenderField[] = ['sender_company', 'sender_address', 'privacy_notice_url'];
const SENDER_LABEL: Record<SenderField, 'company' | 'address' | 'privacy'> = {
  sender_company: 'company',
  sender_address: 'address',
  privacy_notice_url: 'privacy',
};
const SENDER_MAX: Record<SenderField, number> = { sender_company: 200, sender_address: 300, privacy_notice_url: 2048 };

/**
 * The sender identity of every commercial email's footer. `missingOnly` shows only the fields
 * still empty (the dialog's inline step); otherwise all three.
 */
export function SenderForm({
  settings,
  missingOnly = false,
  editable = true,
  onSaved,
}: {
  settings: EmailSettingsOut;
  missingOnly?: boolean;
  editable?: boolean;
  onSaved?: (out: EmailSettingsOut) => void;
}) {
  const { t } = useTranslation();
  const guard = useInFlight();
  const [shown] = useState(() => SENDER_FIELDS.filter((f) => !missingOnly || !settings[f].trim()));
  const [values, setValues] = useState<Record<SenderField, string>>(() => ({
    sender_company: settings.sender_company,
    sender_address: settings.sender_address,
    privacy_notice_url: settings.privacy_notice_url,
  }));
  // Filling an empty field is anyone's who writes to people; a value is changed by a manager.
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const save = useSaveEmailSettings((out) => {
    if (!missingOnly) toast.success(t('leads.settings.saved'));
    onSaved?.(out);
  });
  const valid = shown.every((f) => values[f].trim() !== '' || !missingOnly);
  // A group, not a form: it also sits inside the message dialog's own form.
  const submit = () => {
    if (!valid || !editable) return;
    const input: EmailSettingsInput = {};
    for (const f of shown) input[f] = values[f].trim();
    guard((release) => save.mutate(input, { onSettled: release }));
  };
  return (
    <div role="group" className="flex flex-col gap-3" aria-label={t('leads.settings.identity')}>
      <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2" disabled={!editable}>
        {shown.map((f) => (
          <label key={f} className={`flex flex-col gap-1 text-sm ${f === 'privacy_notice_url' ? 'sm:col-span-2' : ''}`}>
            {t(`leads.settings.${SENDER_LABEL[f]}`)}
            <Input
              type={f === 'privacy_notice_url' ? 'url' : 'text'}
              value={values[f]}
              readOnly={!manage && settings[f].trim() !== ''}
              maxLength={SENDER_MAX[f]}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
            />
          </label>
        ))}
      </fieldset>
      <ErrorCallout error={save.error} />
      {editable && (
        <div>
          <Button type="button" size={missingOnly ? 'sm' : undefined} disabled={!valid} loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The business-recipient basis for one channel, opened in place: the legal notice, the owner's
 * record of the counsel's confirmation and its note, in the same save (spec §3.12, D17), exactly
 * as on the full form.
 */
export function BasisStep({ settings, channel, onSaved }: { settings: EmailSettingsOut; channel: ContactChannel; onSaved?: () => void }) {
  const { t } = useTranslation();
  const guard = useInFlight();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const save = useSaveEmailSettings(() => onSaved?.());
  const valid = confirmed && note.trim().length > 0;
  const submit = () => {
    if (!valid) return;
    const input: EmailSettingsInput = {
      b2b_basis: B2B_CHANNELS.filter((c) => c === channel || settings.b2b_basis.includes(c)),
      legal_ack: { counsel_confirmed: true, note: note.trim() },
    };
    guard((release) => save.mutate(input, { onSettled: release }));
  };
  return (
    <div role="group" className="flex flex-col gap-3" aria-label={t('leads.settings.b2b.title')}>
      <Callout tone="warning">{t('leads.settings.b2b.legal')}</Callout>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        {t('leads.settings.b2b.counsel')}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('leads.settings.b2b.note')}
        <Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <ErrorCallout error={save.error} />
      <div>
        <Button type="button" size="sm" disabled={!valid} loading={save.isPending} onClick={submit}>
          {t('leads.settings.b2b.save')}
        </Button>
      </div>
    </div>
  );
}

/** The channels the business-recipient basis may cover (`jt_outreach::B2B_BASIS_CHANNELS`), in the order offered. */
export const B2B_CHANNELS: readonly ContactChannel[] = ['email', 'sms', 'whats_app', 'instagram_dm', 'messenger'];
const B2B_NAMES: Partial<Record<ContactChannel, string>> = { sms: 'SMS', whats_app: 'WhatsApp', instagram_dm: 'Instagram', messenger: 'Messenger' };
const b2bLabel = (language: string, channel: ContactChannel) =>
  language.startsWith('tr')
    ? `${B2B_NAMES[channel]} için işletme alıcısı dayanağını aç`
    : `Open the business-recipient basis for ${B2B_NAMES[channel]}`;

/**
 * The business-recipient basis on every channel: a human owner's act with the counsel's
 * confirmation recorded in the same save (spec §3.12, D17). Off by default.
 */
export function B2bForm({ settings }: { settings: EmailSettingsOut }) {
  const { t, i18n } = useTranslation();
  const guard = useInFlight();
  const [channels, setChannels] = useState<readonly ContactChannel[]>(settings.b2b_basis);
  const [lookup, setLookup] = useState(settings.require_iys_lookup);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const save = useSaveEmailSettings(() => {
    toast.success(t('leads.settings.saved'));
    setConfirmed(false);
    setNote('');
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
    const input: EmailSettingsInput = {
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
            <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
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
