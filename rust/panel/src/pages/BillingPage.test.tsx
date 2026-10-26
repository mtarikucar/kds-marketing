import { expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { me, repMe, workspace } from '@/test/fixtures';
import { billing, entitlement, payment } from '@/test/billing';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';

it('reports evidence with configured instructions and a read-only reference', async () => {
  const user = userEvent.setup();
  const answers = { 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/billing': billing, 'POST /api/billing/payments': payment };
  const calls = mockFetch(answers);
  const { client, router } = renderAt('/billing');
  expect(await screen.findByText('Ödeme bekleniyor')).toBeInTheDocument();
  expect(await screen.findByText(billing.bank_instructions)).toBeInTheDocument();
  expect(screen.getByDisplayValue(billing.payment_reference)).toHaveAttribute('readonly');
  expect(screen.getByText(/TRY/)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Ödenen tutar (kuruş)'), '125000');
  await user.type(screen.getByLabelText('Ödeme zamanı'), '2026-10-24T09:00');
  await user.click(screen.getByRole('button', {name:'Havale bildirimini gönder'}));
  await waitFor(() => expect(calls.some(c => c.path === '/api/billing/payments')).toBe(true));
  const post = calls.find(c => c.path === '/api/billing/payments')!;
  expect(post.body).toMatchObject({reference:billing.payment_reference, amount_minor:125000});
  expect(post.body).not.toHaveProperty('code');
  expect(post.search).toBe('');
  await act(() => router.navigate('/api-keys'));
  expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(billing.payment_reference);
  expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(billing.payment_reference);
});

it('keeps activation input and result page-scoped, including late responses and revisit', async () => {
  const user = userEvent.setup();
  const log = vi.spyOn(console, 'log');
  const answers = { 'GET /api/auth/me': me, 'GET /api/workspace': workspace,
    'GET /api/billing': {...billing, entitlement, payment:{...payment,confirmed:true}},
    'POST /api/billing/activate': delayed(100, {...billing, workspace_status:'active', entitlement:{...entitlement,activated_at:'2026-10-24T11:00:00Z'}}) };
  const calls = mockFetch(answers);
  const { client, router } = renderAt('/billing', {strict:true});
  const input = await screen.findByLabelText('Etkinleştirme kodunu gir');
  expect(input).toHaveAttribute('type','password');
  expect(screen.getByText(/72 saat/)).toBeInTheDocument();
  await user.type(input, 'ABCD1234');
  await user.click(screen.getByRole('button',{name:'Çalışma alanını etkinleştir'}));
  await act(() => router.navigate('/api-keys'));
  await act(() => new Promise(resolve => setTimeout(resolve,150)));
  expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(billing.payment_reference);
  expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain('ABCD1234');
  expect(JSON.stringify(log.mock.calls)).not.toContain('ABCD1234');
  expect(calls.find(c=>c.path==='/api/billing/activate')?.body).toEqual({code:'ABCD1234'});
  expect(calls.every(c=>!c.search.includes('ABCD1234'))).toBe(true);
  await act(() => router.navigate('/billing'));
  expect(await screen.findByLabelText('Etkinleştirme kodunu gir')).toHaveValue('');
});

it('shows the real activation refusal and limits payment actions to current owners', async () => {
  const user = userEvent.setup();
  mockFetch({'GET /api/auth/me':me,'GET /api/workspace':workspace,'GET /api/billing':{...billing,entitlement},
    'POST /api/billing/activate':withStatus(422,{code:'VALIDATION',message:'invalid code',details:{}})});
  const view=renderAt('/billing');
  await user.type(await screen.findByLabelText('Etkinleştirme kodunu gir'),'WRONG123');
  await user.click(screen.getByRole('button',{name:'Çalışma alanını etkinleştir'}));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByLabelText('Etkinleştirme kodunu gir')).toHaveValue('');
  view.unmount();
  mockFetch({'GET /api/auth/me':repMe,'GET /api/workspace':{...workspace,my_role:'rep',my_permissions:['workspace.read']},'GET /api/billing':billing});
  renderAt('/billing');
  await screen.findByText('Ödeme bekleniyor');
  expect(screen.queryByRole('button',{name:'Havale bildirimini gönder'})).not.toBeInTheDocument();
});

it('walks from payment notification through operator confirmation to activation',async()=>{
  const user=userEvent.setup();
  const answers: Record<string,unknown> = {'GET /api/auth/me':me,'GET /api/workspace':workspace,'GET /api/billing':billing,
    'POST /api/billing/payments':payment,'POST /api/billing/activate':{...billing,workspace_status:'active'}};
  mockFetch(answers);
  const {client}=renderAt('/billing');
  await screen.findByDisplayValue(billing.payment_reference);
  await user.type(screen.getByLabelText('Ödenen tutar (kuruş)'),'125000');
  await user.type(screen.getByLabelText('Ödeme zamanı'),'2026-10-24T09:00');
  answers['GET /api/billing']={...billing,payment};
  await user.click(screen.getByRole('button',{name:'Havale bildirimini gönder'}));
  expect(await screen.findByText('İşletmen onayı bekleniyor')).toBeInTheDocument();
  expect(screen.queryByLabelText('Etkinleştirme kodunu gir')).not.toBeInTheDocument();
  answers['GET /api/billing']={...billing,payment:{...payment,confirmed:true},entitlement};
  await act(()=>client.invalidateQueries({queryKey:['billing']}));
  await user.type(await screen.findByLabelText('Etkinleştirme kodunu gir'),'ABCD1234');
  answers['GET /api/billing']={...billing,workspace_status:'active',payment:{...payment,confirmed:true},entitlement:{...entitlement,activated_at:'2026-10-24T11:00:00Z'}};
  answers['GET /api/workspace']={...workspace,status:'active'};
  await user.click(screen.getByRole('button',{name:'Çalışma alanını etkinleştir'}));
  expect(await screen.findByText('Çalışma alanı açık')).toBeInTheDocument();
  expect(screen.queryByLabelText('Etkinleştirme kodunu gir')).not.toBeInTheDocument();
  expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain('ABCD1234');
});
