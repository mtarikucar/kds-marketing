import { expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
const row = { workspace_id:'ws',payment_id:'payment',reference:'SYNTHETIC-TRANSFER',amount_minor:12300,currency:'TRY',paid_at:'2026-10-24T09:00:00Z',reported_at:'2026-10-24T09:00:00Z',entitlement:null };
const entitlement = { id:'grant',source:'paid',payment_id:'payment',confirmed_at:row.paid_at,activated_at:null,revoked_at:null };
const workspace = { id:'ws',status:'pending_payment' };
const base='/api/platform/workspaces/ws';
it('console_confirmation_retry_keeps_current_status', async () => {
  mockFetch({'GET /api/platform/workspaces':[], 'GET /api/platform/payments':[row], [`POST ${base}/payments/payment/confirm`]:{workspace:{...workspace,status:'suspended'},entitlement:{...entitlement,activated_at:row.paid_at},activation:null}});
  const user=userEvent.setup(); renderAt('/platform/payments');
  expect(await screen.findByText('SYNTHETIC-TRANSFER')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Havale doğrulandı'}));
  expect(await screen.findByText('Askıda')).toBeInTheDocument();
  expect(screen.queryByLabelText('Etkinleştirme kodu')).not.toBeInTheDocument();
});
it('console_code_reissue_and_reason_forms', async () => {
  const answers={ 'GET /api/platform/workspaces':[], 'GET /api/platform/payments':[row],
    [`POST ${base}/payments/payment/confirm`]:{workspace,entitlement,activation:{code:'ABCD1234',expires_at:'2026-10-27T09:00:00Z'}},
    [`POST ${base}/payments/payment/reissue`]:{workspace,entitlement,activation:{code:'WXYZ5678',expires_at:'2026-10-28T09:00:00Z'}},
    [`POST ${base}/revoke-activation`]:workspace };
  const calls=mockFetch(answers); const user=userEvent.setup(); const {client,router}=renderAt('/platform/payments');
  await user.click(await screen.findByRole('button',{name:'Havale doğrulandı'}));
  expect(await screen.findByText('ABCD1234')).toBeInTheDocument();
  expect(screen.getByText(/27 Eki 2026/)).toBeInTheDocument();
  expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain('ABCD1234');
  expect(JSON.stringify(client.getMutationCache().getAll().map(m=>m.state))).not.toContain('ABCD1234');
  expect(JSON.stringify(localStorage)).not.toContain('ABCD1234');
  await user.click(screen.getByRole('button',{name:'Kodu yeniden oluştur'}));
  expect(await screen.findByText('WXYZ5678')).toBeInTheDocument();
  expect(screen.queryByText('ABCD1234')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Etkinleştirmeyi geri al'}));
  expect(screen.getByRole('button',{name:'Onayla'})).toBeDisabled();
  await user.type(screen.getByLabelText('Gerekçe'),'Synthetic cancellation');
  await user.click(screen.getByRole('button',{name:'Onayla'}));
  await waitFor(()=>expect(calls.find(c=>c.path.endsWith('revoke-activation'))?.body).toEqual({reason:'Synthetic cancellation'}));
  expect(screen.queryByText('WXYZ5678')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Havale doğrulandı'}));
  await screen.findByText('ABCD1234');
  await act(()=>router.navigate('/platform/workspaces'));
  expect(screen.queryByText('ABCD1234')).not.toBeInTheDocument();
  await act(()=>router.navigate('/platform/payments'));
  await screen.findByText('SYNTHETIC-TRANSFER');
  expect(screen.queryByText('ABCD1234')).not.toBeInTheDocument();
});

it('console_distinguishes_revoked_from_pending_and_reconfirmed_payments', async () => {
  const revoked = { ...row, entitlement: { ...entitlement, activated_at: row.paid_at, revoked_at: row.paid_at } };
  mockFetch({
    'GET /api/platform/workspaces': [],
    'GET /api/platform/payments': [revoked, { ...row, payment_id: 'unconfirmed', reference: 'SYNTHETIC-PENDING' }],
    [`POST ${base}/payments/payment/confirm`]: { workspace, entitlement: { ...entitlement, id: 'new-grant' }, activation: null },
  });
  const user = userEvent.setup();
  renderAt('/platform/payments');
  const card = (await screen.findByText('SYNTHETIC-TRANSFER')).closest('section')!;
  const pendingCard = screen.getByText('SYNTHETIC-PENDING').closest('section')!;
  expect(within(card).getByText('Geri alındı')).toBeInTheDocument();
  expect(within(card).queryByText('Etkinleştirildi')).not.toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Kodu yeniden oluştur' })).toBeDisabled();
  expect(within(pendingCard).getByText('Onay bekliyor')).toBeInTheDocument();
  expect(screen.queryByText('Onay bekliyor veya geri alındı')).not.toBeInTheDocument();
  await user.click(within(card).getByRole('button', { name: 'Havale doğrulandı' }));
  await waitFor(() => expect(within(card).queryByText('Geri alındı')).not.toBeInTheDocument());
  expect(within(card).getByRole('button', { name: 'Kodu yeniden oluştur' })).toBeEnabled();
  expect(within(card).getByText('Havale doğrulandı', { selector: 'dd' })).toBeInTheDocument();
  expect(within(pendingCard).getByText('Onay bekliyor')).toBeInTheDocument();
});
