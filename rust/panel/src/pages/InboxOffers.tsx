import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import type { InboxAppointment, SendChannel, SendIntent } from '@/api/types';
import { formatMoney } from '@/lib/format';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Input, Textarea } from '@/components/ui';
import { ChannelField, DeliveryState, IntentField } from './InboxCompliance';
import { InboxTime, useInboxKey, useInboxMutation } from './InboxShared';

export function InboxQuotes({ journeyId, terminal }: { journeyId: string; terminal: boolean }) {
  const { t, i18n } = useTranslation();
  const key = useInboxKey();
  const rows = useQuery({ queryKey: [...key, 'quotes', journeyId], queryFn: () => api.listQuotes(journeyId) });
  const accept = useInboxMutation(api.acceptQuote);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [until, setUntil] = useState('');
  const [file, setFile] = useState('');
  const [channel, setChannel] = useState<SendChannel>('email');
  const [intent, setIntent] = useState<SendIntent>('reply');
  const [text, setText] = useState('');
  const [delivery, setDelivery] = useState<string>();
  const attempt = useRef<{ body: string; key: string }>();
  const send = useInboxMutation(async () => {
    const input = { amount_minor: Number(amount), currency, valid_until: new Date(until).toISOString(), file_ref: file.trim() || null, channel, text: text.trim(), intent };
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    const out = await api.sendQuote(journeyId, { ...input, request_key: attempt.current.key });
    setDelivery(out.delivery.state);
    setText('');
  });
  const valid = !terminal && amount !== '' && Number.isSafeInteger(Number(amount)) && Number(amount) >= 0 && /^[A-Z]{3}$/.test(currency) && new Date(until).getTime() > Date.now() && !!text.trim();
  return <section className="flex flex-col gap-3 border-t pt-4">
    <h3 className="font-medium">{t('inbox.offers.quotes')}</h3>
    <QueryState query={rows}><ul className="space-y-3 text-sm">{rows.data?.map(row => <li key={row.id}>
      <p>{formatMoney(row.amount_minor, row.currency, i18n.language)} · {t(`inbox.offers.quoteState.${row.state}`)} · <InboxTime at={row.valid_until} /></p>
      {row.file_ref && <p>{row.file_ref}</p>}
      {!terminal && row.state === 'sent' && new Date(row.valid_until).getTime() > Date.now() && <Button size="sm" variant="outline" loading={accept.isPending} onClick={() => accept.mutate(row.id)}>{t('inbox.offers.accept')}</Button>}
    </li>)}</ul></QueryState>
    <ErrorCallout error={accept.error} />
    {!terminal && <form aria-label={t('inbox.offers.send')} className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (valid) send.mutate(); }}>
      <label className="text-sm">{t('inbox.amount')}<Input type="number" min="0" step="1" required value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="text-sm">{t('inbox.currency')}<Input required pattern="[A-Z]{3}" maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></label>
      <label className="text-sm">{t('inbox.offers.validUntil')}<Input type="datetime-local" required value={until} onChange={e => setUntil(e.target.value)} /></label>
      <label className="text-sm">{t('inbox.offers.file')}<Input value={file} onChange={e => setFile(e.target.value)} /></label>
      <p className="text-sm text-muted-foreground">{t('inbox.offers.fileHint')}</p>
      <ChannelField sending value={channel} onChange={v => setChannel(v as SendChannel)} />
      <IntentField value={intent} onChange={setIntent} />
      <label className="text-sm">{t('inbox.offers.text')}<Textarea required value={text} onChange={e => setText(e.target.value)} /></label>
      <ErrorCallout error={send.error} />
      {delivery && <DeliveryState state={delivery} />}
      <Button type="submit" disabled={!valid} loading={send.isPending}>{t('inbox.offers.send')}</Button>
    </form>}
  </section>;
}

export function InboxAppointments({ journeyId, appointments, terminal }: { journeyId: string; appointments: InboxAppointment[]; terminal: boolean }) {
  const { t } = useTranslation();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [location, setLocation] = useState('');
  const [intent, setIntent] = useState<SendIntent>('reply');
  const [notification, setNotification] = useState<string>();
  const book = useInboxMutation(async () => {
    const out = await api.bookAppointment(journeyId, { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), location: location.trim(), intent });
    setNotification(out.notification.state);
    setStart(''); setEnd(''); setLocation('');
  });
  const action = useInboxMutation(({ id, kind }: { id: string; kind: 'cancel' | 'held' }) => api.appointmentAction(id, kind));
  const valid = !terminal && !!location.trim() && new Date(end).getTime() > new Date(start).getTime();
  return <section className="flex flex-col gap-3 border-t pt-4">
    <h3 className="font-medium">{t('inbox.offers.appointments')}</h3>
    <p className="text-sm text-muted-foreground">{t('inbox.offers.internal')}</p>
    <ul className="space-y-3 text-sm">{appointments.map(row => <li key={row.id}>
      <p>{row.location} · <InboxTime at={row.starts_at} /> – <InboxTime at={row.ends_at} /> · {t(`inbox.offers.appointmentState.${row.state}`)}</p>
      {row.state === 'booked' && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" loading={action.isPending} onClick={() => action.mutate({ id: row.id, kind: 'cancel' })}>{t('inbox.offers.cancel')}</Button>
        {!terminal && <Button size="sm" variant="outline" loading={action.isPending} onClick={() => action.mutate({ id: row.id, kind: 'held' })}>{t('inbox.offers.held')}</Button>}
      </div>}
    </li>)}</ul>
    <ErrorCallout error={action.error} />
    {!terminal && <form aria-label={t('inbox.offers.book')} className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (valid) book.mutate(); }}>
      <label className="text-sm">{t('inbox.offers.start')}<Input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
      <label className="text-sm">{t('inbox.offers.end')}<Input type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)} /></label>
      <label className="text-sm">{t('inbox.offers.location')}<Input required value={location} onChange={e => setLocation(e.target.value)} /></label>
      <IntentField value={intent} onChange={setIntent} />
      <ErrorCallout error={book.error} />
      {notification && <DeliveryState notification state={notification} />}
      <Button type="submit" disabled={!valid} loading={book.isPending}>{t('inbox.offers.book')}</Button>
    </form>}
  </section>;
}
