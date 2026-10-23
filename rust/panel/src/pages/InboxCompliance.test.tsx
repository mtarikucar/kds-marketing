import { expect, it } from 'vitest';
import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { inboxAnswers, inboxMe } from '@/test/inbox';

const answers = {
  ...inboxAnswers,
  'GET /api/inbox/people/person-1/consents': { consents: [], suppressions: [{ channel: 'email', reason: 'bounce' }] },
};

it('adds only a manual suppression for the selected channel', async () => {
  const calls = mockFetch({ ...answers, 'POST /api/inbox/people/person-1/suppressions': {} });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /İzin ve engellemeler/ }));
  const form = await screen.findByRole('form', { name: 'İzin kaydet' });
  await userEvent.selectOptions(within(form).getByLabelText('Kanal'), 'sms');
  await userEvent.click(within(form).getByRole('button', { name: 'Seçili kanalı engelle' }));
  await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path.endsWith('/suppressions'))?.body).toEqual({ channel: 'sms', reason: 'manual' }));
});

it('records channel consent with its effective time and source', async () => {
  const calls = mockFetch({ ...answers, 'POST /api/inbox/people/person-1/consents': {} });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /İzin ve engellemeler/ }));
  const user = userEvent.setup();
  const form = await screen.findByRole('form', { name: 'İzin kaydet' });
  await user.selectOptions(within(form).getByLabelText('Kanal'), 'email');
  await user.selectOptions(within(form).getByLabelText('Karar'), 'withdrawn');
  await user.selectOptions(within(form).getByLabelText('Kaynak'), 'customer');
  fireEvent.change(within(form).getByLabelText('Karar zamanı'), { target: { value: '2020-01-02T10:00' } });
  await user.click(within(form).getByRole('button', { name: 'İzin kaydet' }));
  await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path.endsWith('/consents'))?.body).toEqual({
    channel: 'email', kind: 'withdrawn', source: 'customer', at: new Date('2020-01-02T10:00').toISOString(),
  }));
});

it('removes only the selected suppression', async () => {
  const calls = mockFetch({ ...answers, 'DELETE /api/inbox/people/person-1/suppressions/email/bounce': {} });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /İzin ve engellemeler/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Engeli kaldır: E-posta / Geri sıçrama' }));
  await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path.endsWith('/suppressions/email/bounce'))).toBe(true));
});

it('does not expose suppression or erasure actions without manage permission', async () => {
  mockFetch({ ...answers, 'GET /api/auth/me': { ...inboxMe, memberships: inboxMe.memberships.map(m => ({ ...m, permissions: ['inbox.work'] })) } });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /İzin ve engellemeler/ }));
  await screen.findByRole('form', { name: 'İzin kaydet' });
  expect(screen.queryByRole('button', { name: /Engeli kaldır/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Kişisel verileri sil' })).not.toBeInTheDocument();
});

it('keeps the request key on a failed commercial send retry', async () => {
  const calls = mockFetch({ ...answers, 'POST /api/inbox/people/person-1/send': withStatus(503, { code: 'UNAVAILABLE', message: 'retry', details: {} }) });
  renderAt('/inbox?person=person-1');
  await userEvent.click(await screen.findByRole('button', { name: /İzin ve engellemeler/ }));
  const form = await screen.findByRole('form', { name: 'Ticari mesaj gönder' });
  const user = userEvent.setup();
  await user.type(within(form).getByLabelText('Mesaj'), 'Merhaba');
  const send = within(form).getByRole('button', { name: 'Ticari mesaj gönder' });
  await user.click(send);
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await waitFor(() => expect(calls.filter(c => c.path.endsWith('/send'))).toHaveLength(2));
  const bodies = calls.filter(c => c.path.endsWith('/send')).map(c => c.body);
  expect(bodies[0]).toEqual({ channel: 'email', text: 'Merhaba', intent: 'commercial', request_key: expect.any(String) });
  expect(bodies[1]).toEqual(bodies[0]);
});
