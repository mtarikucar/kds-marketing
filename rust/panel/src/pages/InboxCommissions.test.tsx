import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { inboxAnswers, inboxMe } from '@/test/inbox';
import { USER_ID } from '@/test/fixtures';

const rows = [
  { id: 'pending', journey_id: 'j1', payee: USER_ID, amount_minor: 200, currency: 'TRY', rate_bp: 100, state: 'pending' },
  { id: 'approved', journey_id: 'j2', payee: USER_ID, amount_minor: 300, currency: 'TRY', rate_bp: 100, state: 'approved' },
  { id: 'missing', journey_id: 'j3', payee: null, amount_minor: 400, currency: 'TRY', rate_bp: 100, state: 'no_payee' },
  { id: 'paid', journey_id: 'j4', payee: null, amount_minor: 500, currency: 'TRY', rate_bp: 100, state: 'paid' },
];
const answers = { ...inboxAnswers, 'GET /api/inbox/commissions': rows };
describe('Inbox commissions', () => {
  it('commission_amounts_use_minor_units', async () => {
    mockFetch({ ...answers, 'GET /api/inbox/commissions': [
      { ...rows[0], id: 'jpy', amount_minor: 1000, currency: 'JPY' },
      { ...rows[0], id: 'kwd', amount_minor: 1000, currency: 'KWD' },
      { ...rows[0], id: 'try', amount_minor: 12345, currency: 'TRY' },
    ] });
    renderAt('/inbox/commissions');
    expect((await screen.findByTestId('commission-jpy')).querySelector('strong')).toHaveTextContent('¥1.000');
    expect(screen.getByTestId('commission-kwd').querySelector('strong')).toHaveTextContent('KWD 1,000');
    expect(screen.getByTestId('commission-try').querySelector('strong')).toHaveTextContent('₺123,45');
  });
  it('offers only the next valid payment action and sends shared rate inputs', async () => {
    const calls = mockFetch({ ...answers, 'POST /api/inbox/commissions/pending/approve': { ...rows[0], state: 'approved' }, 'POST /api/inbox/commissions/approved/pay': { ...rows[1], state: 'paid' }, 'PUT /api/inbox/commission-rates': { user_id: null, rate_bp: 250 } });
    renderAt('/inbox/commissions');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Onayla' }));
    await user.click(screen.getByRole('button', { name: 'Ödendi olarak işaretle' }));
    expect(calls.some(c => c.path === '/api/inbox/commissions/pending/approve')).toBe(true);
    expect(calls.some(c => c.path === '/api/inbox/commissions/approved/pay')).toBe(true);
    for (const id of ['missing', 'paid']) {
      expect(within(screen.getByTestId(`commission-${id}`)).queryByRole('button')).not.toBeInTheDocument();
    }
    await user.type(screen.getByRole('spinbutton', { name: 'Oran (baz puan)' }), '250');
    await user.click(screen.getByRole('button', { name: 'Oranı kaydet' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ user_id: null, rate_bp: 250 }));
  });
  it('filters state and payee and keeps rep access read only', async () => {
    const rep = { ...inboxMe, memberships: [{ ...inboxMe.memberships[0], role_key: 'rep', permissions: ['workspace.read', 'inbox.work'] }] };
    const calls = mockFetch({ ...answers, 'GET /api/auth/me': rep });
    renderAt('/inbox/commissions');
    await screen.findByTestId('commission-missing');
    expect(screen.queryByRole('button', { name: 'Onayla' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Oranı kaydet' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Komisyon durumu'), 'pending');
    await waitFor(() => expect(calls.some(c => c.search.includes('state=pending'))).toBe(true));
  });
});
