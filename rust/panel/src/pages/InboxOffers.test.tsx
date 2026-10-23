import { expect, it } from 'vitest';
import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { inboxAnswers } from '@/test/inbox';

it('shows quote amounts in currency minor units and accepts the selected quote', async () => {
  const calls = mockFetch({ ...inboxAnswers,
    'GET /api/inbox/journeys/journey-1/quotes': [{ id: 'quote-jpy', amount_minor: 1200, currency: 'JPY', valid_until: '2099-01-01T00:00:00Z', file_ref: 'asset:offer', state: 'sent' }],
    'POST /api/inbox/quotes/quote-jpy/accept': {},
  });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /Teklifler/ }));
  expect(await screen.findByText(/1\.200/)).toBeVisible();
  expect(screen.queryByRole('link', { name: 'asset:offer' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Teklifi kabul et' }));
  await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/quotes/quote-jpy/accept'))).toBe(true));
});

it('sends a quote using the shared input and shows uncertain delivery separately', async () => {
  const calls = mockFetch({ ...inboxAnswers,
    'GET /api/inbox/journeys/journey-1/quotes': [],
    'POST /api/inbox/journeys/journey-1/quotes': { quote: { id: 'quote-1' }, delivery: { message_id: 'msg-1', state: 'unknown' } },
  });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /Teklifler/ }));
  const form = await screen.findByRole('form', { name: 'Teklif gönder' });
  const user = userEvent.setup();
  await user.type(within(form).getByLabelText('Tutar (kuruş / alt birim)'), '12000');
  fireEvent.change(within(form).getByLabelText('Geçerlilik sonu'), { target: { value: '2099-01-02T10:00' } });
  await user.type(within(form).getByLabelText('Dosya referansı (isteğe bağlı)'), 'asset:offer');
  await user.type(within(form).getByLabelText('Mesaj'), 'Teklifimiz');
  await user.selectOptions(within(form).getByLabelText('Gönderim amacı'), 'commercial');
  await user.click(within(form).getByRole('button', { name: 'Teklif gönder' }));
  await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path.endsWith('/quotes'))?.body).toEqual({
    amount_minor: 12000, currency: 'TRY', valid_until: new Date('2099-01-02T10:00').toISOString(),
    file_ref: 'asset:offer', channel: 'email', text: 'Teklifimiz', intent: 'commercial', request_key: expect.any(String),
  }));
  expect(await within(form).findByText(/Teslim durumu: Belirsiz/)).toBeInTheDocument();
});

it('books internal appointments and keeps notification refusal visible', async () => {
  const calls = mockFetch({ ...inboxAnswers,
    'POST /api/inbox/journeys/journey-1/appointments': { appointment: { id: 'appointment-1' }, reminder: {}, notification: { state: 'refused', message_id: null } },
  });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /Randevular/ }));
  const form = await screen.findByRole('form', { name: 'Randevu oluştur' });
  const user = userEvent.setup();
  fireEvent.change(within(form).getByLabelText('Başlangıç'), { target: { value: '2099-01-02T10:00' } });
  fireEvent.change(within(form).getByLabelText('Bitiş'), { target: { value: '2099-01-02T09:00' } });
  await user.type(within(form).getByLabelText('Yer'), 'Ofis');
  const submit = within(form).getByRole('button', { name: 'Randevu oluştur' });
  expect(submit).toBeDisabled();
  fireEvent.change(within(form).getByLabelText('Bitiş'), { target: { value: '2099-01-02T11:00' } });
  await user.click(submit);
  await waitFor(() => expect(calls.find(c => c.path.endsWith('/appointments'))?.body).toEqual({
    starts_at: new Date('2099-01-02T10:00').toISOString(), ends_at: new Date('2099-01-02T11:00').toISOString(), location: 'Ofis', intent: 'reply',
  }));
  expect(await within(form).findByText(/Bildirim: Reddedildi/)).toBeInTheDocument();
});

it.each(['cancel', 'held'])('loads existing appointments and performs %s after navigation', async action => {
  const appointment = { id: 'appointment-1', starts_at: '2099-01-02T10:00:00Z', ends_at: '2099-01-02T11:00:00Z', location: 'Ofis', state: 'booked' };
  const calls = mockFetch({ ...inboxAnswers,
    'GET /api/inbox/journeys/journey-1': { ...(inboxAnswers['GET /api/inbox/journeys/journey-1'] as object), appointments: [appointment] },
    [`POST /api/inbox/appointments/appointment-1/${action}`]: { ...appointment, state: action === 'held' ? 'held' : 'cancelled' },
  });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /Randevular/ }));
  await userEvent.click(await screen.findByRole('button', { name: action === 'held' ? 'Görüşme yapıldı' : 'Randevuyu iptal et' }));
  await waitFor(() => expect(calls.some(c => c.path.endsWith(`/appointment-1/${action}`))).toBe(true));
});
