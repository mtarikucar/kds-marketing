import { expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, renderAt } from '@/test/render';
import { studioAnswers } from '@/test/studio';

it('opens the ads module under its own title', async () => {
  mockFetch(studioAnswers);
  renderAt('/ads?tab=external');
  expect(await screen.findByRole('heading', { level: 1, name: 'Reklam yönetimi' })).toBeVisible();
});


import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import { overview } from '@/test/studio';

const paid = { ...overview, lane_support: { ...overview.lane_support, paid: { visible: true, supported: true } },
  learned: { ...overview.learned, arms: [{ ...overview.learned.arms[0], arm: { ...overview.learned.arms[0].arm, key: { ...overview.learned.arms[0].arm.key, lane: 'paid' } } }], spend_vs_cap: [{ lane: 'paid', currency: 'TRY', cap_minor: 10000, observed_minor: 0 }] },
  bindings: [{ id: 'b1', account_id: 'account', adset_id: 'set1' }],
  today: { ...overview.today, approvals: [{ budget_move: 'move1' }], budget_moves: [{ id: 'move1', daily_budget_minor: 15000, currency: 'TRY', state: 'queued', revision: 7 }] },
};

it.each([[false, false], [false, true], [true, false], [true, true]])('paid actions follow account %s and strategy %s availability', async (account, strategy) => {
  const visible = account && strategy;
  mockFetch({ ...studioAnswers, 'GET /api/studio/overview': { ...paid, lane_support: { ...paid.lane_support, paid: { visible, supported: visible } } } });
  renderAt('/ads?tab=external');
  await screen.findByRole('heading', { level: 1, name: 'Reklam yönetimi' });
  if (visible) expect(await screen.findByText('Reklam seti bağla', { selector: 'summary' })).toBeVisible();
  else {
    expect(await screen.findByText(/Reklam yönetimi için bağlı bir reklam hesabı/)).toBeVisible();
    expect(screen.queryByText('Reklam seti bağla')).not.toBeInTheDocument();
  }
});

it('binds an ad set, submits a currency budget and approves a pending move with its revision', async () => {
  const calls = mockFetch({ ...studioAnswers, 'GET /api/studio/overview': paid,
    'GET /api/capabilities': [{ capability: { id: 'c1', name: 'Reklam hesabı' } }],
    'GET /api/studio/adsets': [{ id: 'set1', name: 'Sonbahar', status: 'ACTIVE' }],
    'POST /api/studio/adsets/bind': {}, 'POST /api/studio/budget-moves': {}, 'POST /api/studio/approvals': {},
  });
  renderAt('/ads?tab=external');
  const user = userEvent.setup();
  await user.click(await screen.findByText('Reklam seti bağla', { selector: 'summary' }));
  await user.selectOptions(screen.getByLabelText('Reklam hesabı'), 'c1');
  await screen.findByRole('option', { name: 'Sonbahar (ACTIVE)' });
  await user.selectOptions(screen.getByLabelText('Mevcut reklam seti'), 'set1');
  await user.selectOptions(screen.getByLabelText('İçerik çeşidi'), 'a1');
  await user.click(screen.getByRole('button', { name: 'Reklam seti bağla' }));
  await waitFor(() => expect(calls.find(c => c.path === '/api/studio/adsets/bind')?.body).toMatchObject({ hypothesis_id: 'h1', arm_id: 'a1', capability_id: 'c1', adset_id: 'set1' }));
  await user.click(screen.getByText('Günlük bütçeyi değiştir', { selector: 'summary' }));
  await user.selectOptions(screen.getByLabelText('Bağlı reklam seti'), 'b1');
  await user.type(screen.getByLabelText('Günlük bütçe'), '150,50');
  await user.click(screen.getByRole('button', { name: 'Günlük bütçeyi değiştir' }));
  await waitFor(() => expect(calls.find(c => c.path === '/api/studio/budget-moves')?.body).toMatchObject({ binding_id: 'b1', daily_budget_minor: 15050, currency: 'TRY' }));
  await user.click(screen.getByRole('button', { name: 'Onayla' }));
  await waitFor(() => expect(calls.find(c => c.path === '/api/studio/approvals')?.body).toEqual({ target: { budget_move: 'move1' }, expected_revision: 7 }));
});

it('allows ads workers to bind but hides money-management controls', async () => {
  const me = studioAnswers['GET /api/auth/me'];
  mockFetch({ ...studioAnswers, 'GET /api/auth/me': { ...me, memberships: [{ ...me.memberships[0], permissions: ['ads.work'] }] }, 'GET /api/studio/overview': paid });
  renderAt('/ads?tab=external');
  expect(await screen.findByText('Reklam seti bağla', { selector: 'summary' })).toBeVisible();
  expect(screen.queryByText('Günlük bütçeyi değiştir')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Onayla' })).not.toBeInTheDocument();
});


it('does not fetch ads data with only another module permission', async () => {
  const session = studioAnswers['GET /api/auth/me'];
  const calls = mockFetch({ ...studioAnswers, 'GET /api/auth/me': { ...session, memberships: [{ ...session.memberships[0], permissions: ['materials.work'] }] } });
  renderAt('/ads?tab=external');
  expect(await screen.findByRole('alert')).toHaveTextContent('Bu işlem için yetkiniz yok');
  expect(calls.some(c => c.path.startsWith('/api/studio/'))).toBe(false);
});
