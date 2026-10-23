import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import type { ConsentInput, ContactChannel, SendChannel, SendIntent } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Input, Textarea } from '@/components/ui';
import { InboxTime, selectClass, useInboxKey, useInboxMutation } from './InboxShared';

const channels: ContactChannel[] = ['email', 'sms', 'phone', 'whats_app', 'messenger', 'instagram_dm', 'webchat'];
export function ChannelField({ value, onChange, sending = false }: { value: ContactChannel; onChange: (value: ContactChannel) => void; sending?: boolean }) {
  const { t } = useTranslation();
  return <label className="text-sm">{t('inbox.compliance.channel')}<select className={selectClass} value={value} onChange={e => onChange(e.target.value as ContactChannel)}>
    {channels.filter(c => !sending || (c !== 'phone' && c !== 'webchat')).map(c => <option key={c} value={c}>{t(`inbox.compliance.channels.${c}`)}</option>)}
  </select></label>;
}
export function IntentField({ value, onChange }: { value: SendIntent; onChange: (value: SendIntent) => void }) {
  const { t } = useTranslation();
  return <label className="text-sm">{t('inbox.compliance.intent')}<select className={selectClass} value={value} onChange={e => onChange(e.target.value as SendIntent)}>
    {(['reply', 'commercial'] as const).map(v => <option key={v} value={v}>{t(`inbox.compliance.intents.${v}`)}</option>)}
  </select></label>;
}
export function DeliveryState({ state, notification = false }: { state: string; notification?: boolean }) {
  const { t } = useTranslation();
  return <p role="status" className="text-sm">{t(notification ? 'inbox.offers.notification' : 'inbox.offers.delivery')}: {t(`inbox.offers.deliveryState.${state}`, { defaultValue: state })}</p>;
}

export function InboxCompliance({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const key = useInboxKey();
  const data = useQuery({ queryKey: [...key, 'consents', personId], queryFn: () => api.listConsents(personId) });
  const [channel, setChannel] = useState<ContactChannel>('email');
  const [kind, setKind] = useState<ConsentInput['kind']>('explicit');
  const [source, setSource] = useState<ConsentInput['source']>('customer');
  const [at, setAt] = useState('');
  const save = useInboxMutation(() => api.recordConsent(personId, { channel, kind, source, at: new Date(at).toISOString() }));
  const add = useInboxMutation(() => api.addSuppression(personId, channel));
  const remove = useInboxMutation((row: { channel: ContactChannel; reason: Parameters<typeof api.removeSuppression>[2] }) => api.removeSuppression(personId, row.channel, row.reason));
  const valid = !!at && Number.isFinite(new Date(at).getTime()) && new Date(at).getTime() <= Date.now();
  return <section className="flex flex-col gap-3 border-t pt-4">
    <h3 className="font-medium">{t('inbox.compliance.title')}</h3>
    <QueryState query={data}>{data.data && <>
      <ul className="space-y-2 text-sm">{data.data.consents.map(row => <li key={row.id}>
        {t(`inbox.compliance.channels.${row.channel}`)} · {t(`inbox.compliance.kinds.${row.kind}`)} · {t(`inbox.compliance.sources.${row.source}`)} · <InboxTime at={row.at} /> · {t(`inbox.compliance.sync.${row.sync_state}`)}
      </li>)}</ul>
      <ul className="space-y-2 text-sm">{data.data.suppressions.map(row => <li key={`${row.channel}:${row.reason}`}>
        {t(`inbox.compliance.channels.${row.channel}`)} / {t(`inbox.compliance.reasons.${row.reason}`)}
        {manage && <Button variant="outline" size="sm" loading={remove.isPending} onClick={() => remove.mutate(row)} aria-label={t('inbox.compliance.removeNamed', { channel: t(`inbox.compliance.channels.${row.channel}`), reason: t(`inbox.compliance.reasons.${row.reason}`) })}>{t('inbox.compliance.remove')}</Button>}
      </li>)}</ul>
    </>}</QueryState>
    <form aria-label={t('inbox.compliance.record')} className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (valid) save.mutate(); }}>
      <ChannelField value={channel} onChange={setChannel} />
      <label className="text-sm">{t('inbox.compliance.kind')}<select className={selectClass} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>{(['explicit', 'implied_by_contract', 'withdrawn'] as const).map(v => <option key={v} value={v}>{t(`inbox.compliance.kinds.${v}`)}</option>)}</select></label>
      <label className="text-sm">{t('inbox.compliance.source')}<select className={selectClass} value={source} onChange={e => setSource(e.target.value as typeof source)}>{(['form', 'agent', 'import', 'iys_sync', 'customer'] as const).map(v => <option key={v} value={v}>{t(`inbox.compliance.sources.${v}`)}</option>)}</select></label>
      <label className="text-sm">{t('inbox.compliance.at')}<Input required type="datetime-local" value={at} onChange={e => setAt(e.target.value)} /></label>
      <ErrorCallout error={save.error} />
      {save.isSuccess && <p role="status">{t('inbox.saved')}</p>}
      <Button type="submit" disabled={!valid} loading={save.isPending}>{t('inbox.compliance.record')}</Button>
      {manage && <Button type="button" variant="outline" loading={add.isPending} onClick={() => add.mutate()}>{t('inbox.compliance.add')}</Button>}
    </form>
    <ErrorCallout error={add.error ?? remove.error} />
    <CommercialForm personId={personId} />
  </section>;
}

function CommercialForm({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<SendChannel>('email');
  const [text, setText] = useState('');
  const [delivery, setDelivery] = useState<string>();
  const attempt = useRef<{ body: string; key: string }>();
  const send = useInboxMutation(async () => {
    const input = { channel, text: text.trim(), intent: 'commercial' as const };
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    const out = await api.sendCommercial(personId, { ...input, request_key: attempt.current.key });
    setDelivery(out.state);
    setText('');
    // Retain the key until the payload changes, including an uncertain delivery.
  });
  return <form aria-label={t('inbox.compliance.send')} className="flex flex-col gap-3 border-t pt-3" onSubmit={e => { e.preventDefault(); if (text.trim()) send.mutate(); }}>
    <h3 className="font-medium">{t('inbox.compliance.send')}</h3>
    <p className="text-sm text-muted-foreground">{t('inbox.compliance.sendHint')}</p>
    <ChannelField sending value={channel} onChange={v => setChannel(v as SendChannel)} />
    <label className="text-sm">{t('inbox.offers.text')}<Textarea required value={text} onChange={e => setText(e.target.value)} /></label>
    <ErrorCallout error={send.error} />
    {delivery && <DeliveryState state={delivery} />}
    <Button type="submit" disabled={!text.trim()} loading={send.isPending}>{t('inbox.compliance.send')}</Button>
  </form>;
}
