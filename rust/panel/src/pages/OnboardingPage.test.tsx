import { expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import { me, workspace, pendingOverdue, smsLine } from '@/test/fixtures';
import { billing, entitlement, payment } from '@/test/billing';
import { mockFetch, renderAt } from '@/test/render';

it('first_run_resumes_after_reload_and_suspend', async () => {
  const answers = {'GET /api/auth/me':me,'GET /api/workspace':{...workspace,status:'active'},
    'GET /api/billing':{...billing,workspace_status:'active',payment:{...payment,confirmed:true},entitlement:{...entitlement,activated_at:'2026-10-24T11:00:00Z'}},
    'GET /api/work/pending':pendingOverdue,'GET /api/capabilities':[smsLine]};
  mockFetch(answers);
  const first=renderAt('/onboarding');
  expect(await screen.findByText('Çalışma alanı açık')).toBeInTheDocument();
  expect(await screen.findByText('Strateji onayı bekleniyor')).toBeInTheDocument();
  expect(await screen.findByText('Bağlayıcı doğrulandı')).toBeInTheDocument();
  expect(screen.getByText(/kendi ajan zamanlayıcınız/)).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'API anahtarı oluştur'})).toHaveAttribute('href','/api-keys');
  first.unmount();
  answers['GET /api/workspace'].status='suspended'; answers['GET /api/billing'].workspace_status='suspended';
  const second=renderAt('/onboarding');
  expect(await screen.findByText('Çalışma alanı askıya alındı')).toBeInTheDocument();
  expect(await screen.findByText('Ödeme onaylandı')).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'API anahtarı oluştur'})).not.toBeInTheDocument();
  await act(()=>second.router.navigate('/api-keys'));
  expect(JSON.stringify(second.client.getQueryCache().getAll())).not.toContain(billing.payment_reference);
});

it('keeps unpaid actions locked and derives confirmation and revocation from current billing', async()=>{
  mockFetch({'GET /api/auth/me':me,'GET /api/workspace':workspace,
    'GET /api/billing':{...billing,payment:{...payment,confirmed:true},entitlement:{...entitlement,revoked_at:'2026-10-24T12:00:00Z'}},
    'GET /api/work/pending':pendingOverdue});
  renderAt('/onboarding');
  expect(await screen.findByText('Ödeme bekleniyor')).toBeInTheDocument();
  expect(await screen.findByText('Etkinleştirme geri alındı')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Stratejiyi hazırla'})).toHaveAttribute('href','/strategy');
  expect(screen.queryByRole('link',{name:'Ekibi davet et'})).not.toBeInTheDocument();
});

it('recognizes grandfathered access without claiming a bank transfer was confirmed',async()=>{
  mockFetch({'GET /api/auth/me':me,'GET /api/workspace':{...workspace,status:'active'},
    'GET /api/billing':{...billing,workspace_status:'active',entitlement:{...entitlement,source:'grandfathered',payment_id:null,activated_at:'2026-10-24T11:00:00Z'}},
    'GET /api/work/pending':pendingOverdue,'GET /api/capabilities':[],'GET /api/team':[],'GET /api/api-keys':[]});
  renderAt('/onboarding');
  expect(await screen.findByText('Önceden tanınmış kalıcı erişim hakkı')).toBeInTheDocument();
  expect(screen.queryByText('Ödeme onayı bekleniyor')).not.toBeInTheDocument();
  expect(screen.queryByText('Ödeme onaylandı')).not.toBeInTheDocument();
});
