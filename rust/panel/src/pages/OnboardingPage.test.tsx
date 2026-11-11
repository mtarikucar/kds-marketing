import { expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { me, workspace, pendingOverdue, smsLine } from '@/test/fixtures';
import { billing, entitlement, payment } from '@/test/billing';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';

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
  await userEvent.setup().click(screen.getByText('Ekip ve ajanlar'));
  expect(screen.getByRole('link',{name:'Ajan bağla'})).toHaveAttribute('href','/agents?connect=1');
  first.unmount();
  answers['GET /api/workspace'].status='suspended'; answers['GET /api/billing'].workspace_status='suspended';
  const second=renderAt('/onboarding');
  expect(await screen.findByText('Çalışma alanı askıya alındı')).toBeInTheDocument();
  expect(await screen.findByText('Ödeme onaylandı')).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Ajan bağla'})).not.toBeInTheDocument();
  await act(()=>second.router.navigate('/agents'));
  expect(JSON.stringify(second.client.getQueryCache().getAll())).not.toContain(billing.payment_reference);
});

it('keeps unpaid actions locked and derives confirmation and revocation from current billing', async()=>{
  mockFetch({'GET /api/auth/me':me,'GET /api/workspace':workspace,
    'GET /api/billing':{...billing,payment:{...payment,confirmed:true},entitlement:{...entitlement,revoked_at:'2026-10-24T12:00:00Z'}},
    'GET /api/work/pending':pendingOverdue});
  renderAt('/onboarding');
  expect(await screen.findByText('Ödeme bekleniyor')).toBeInTheDocument();
  expect(await screen.findByText('Etkinleştirme geri alındı')).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('heading',{name:'Strateji'}));
  expect(screen.getByRole('link',{name:'Stratejiyi hazırla'})).toHaveAttribute('href','/strategy');
  expect(screen.queryByRole('link',{name:'Ekibi davet et'})).not.toBeInTheDocument();
});

it('does not propose a strategy while its setup check is loading or failed',async()=>{
  const answers={'GET /api/auth/me':me,'GET /api/workspace':{...workspace,status:'active'},'GET /api/billing':billing,
    'GET /api/work/pending':delayed(200,pendingOverdue),'GET /api/capabilities':[]};
  mockFetch(answers);const first=renderAt('/onboarding');
  const region=await screen.findByRole('region',{name:'Sıradaki adım'});
  expect(within(region).queryByRole('link')).not.toBeInTheDocument();
  expect(await within(region).findByRole('link',{name:'Bu adıma git'})).toHaveAttribute('href','/strategy');
  first.unmount();
  mockFetch({...answers,'GET /api/work/pending':withStatus(503,{code:'INTERNAL',message:'unavailable',details:{}})});
  renderAt('/onboarding');const failed=await screen.findByRole('region',{name:'Sıradaki adım'});
  expect(await within(failed).findByRole('button',{name:'Yeniden dene'})).toBeInTheDocument();
  expect(within(failed).queryByRole('link')).not.toBeInTheDocument();
});

it('keeps connection advice unavailable on a failed capability check and pauses suspended setup',async()=>{
  const answers={'GET /api/auth/me':me,'GET /api/workspace':{...workspace,status:'active'},'GET /api/billing':billing,
    'GET /api/work/pending':{...pendingOverdue,strategy:{approved:{version_id:'approved',number:1}}},
    'GET /api/capabilities':withStatus(503,{code:'INTERNAL',message:'unavailable',details:{}})};
  mockFetch(answers);const first=renderAt('/onboarding');const region=await screen.findByRole('region',{name:'Sıradaki adım'});
  expect(await within(region).findByRole('button',{name:'Yeniden dene'})).toBeInTheDocument();
  expect(within(region).queryByRole('link')).not.toBeInTheDocument();first.unmount();
  mockFetch({...answers,'GET /api/workspace':{...workspace,status:'suspended'}});renderAt('/onboarding');
  const paused=await screen.findByRole('region',{name:'Sıradaki adım'});
  expect(within(paused).getByText('Kurulum duraklatıldı')).toBeInTheDocument();
  expect(within(paused).queryByRole('link')).not.toBeInTheDocument();
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
