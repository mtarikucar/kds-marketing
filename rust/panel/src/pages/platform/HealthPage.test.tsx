import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
const health={ observed_at:'2026-10-24T09:00:00Z', process_started_at:'2026-10-24T08:00:00Z',history:'unknown_before_process_start',boot_complete:true,database:'ok',files:'ok',disk:'degraded',disk_available_bytes:1234,database_pool_size:5,database_pool_idle:3,jobs:[{name:'refresh',last_success_at:null,failed_total:2,body:'CANARY_JOB'}],connectors:[{workspace_id:'ws',kind_key:'x',reconnect_required:1,expires_before:null,credentials:'CANARY_CREDENTIALS'}],connectors_state:'ok',webhooks:{accepted:3,unrouted:2,unresolved:1,body:'CANARY_WEBHOOK'},backup:{last_backup_at:null,last_wal_archive_at:null,backup_state:'unknown',wal_state:'unknown'},body:'CANARY_BODY'};
it('console_contains_no_tenant_body_drilldown',async()=>{
  const calls=mockFetch({'GET /api/platform/workspaces':[], 'GET /api/platform/health':health});renderAt('/platform/health');
  expect(await screen.findByRole('heading',{name:'Sistem sağlığı'})).toBeInTheDocument();
  await screen.findByText('1234');
  expect(document.body.textContent).not.toContain('CANARY');
  expect(screen.getByRole('link',{name:'Ödeme bildirimleri'})).toHaveAttribute('href','/platform/payments');
  for(const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).toMatch(/^\/platform/);
  expect(calls.every(c=>c.path.startsWith('/api/platform/'))).toBe(true);
});
it('operator reset accepts a target ID and clears the password',async()=>{
  const target='019a1111-1111-7111-8111-111111111111';
  const calls=mockFetch({'GET /api/platform/workspaces':[], 'GET /api/platform/health':health,[`POST /api/platform/operators/${target}/reset-password`]:null});
  const user=userEvent.setup();renderAt('/platform/health');
  await screen.findByText('1234');
  await user.type(screen.getByLabelText('Operatör kimliği'),target);
  await user.type(screen.getByLabelText('Yeni parola'),'synthetic password');
  await user.click(screen.getByRole('button',{name:'Parolayı sıfırla'}));
  await waitFor(()=>expect(calls.find(c=>c.method==='POST')?.body).toEqual({password:'synthetic password'}));
  expect(screen.getByLabelText('Yeni parola')).toHaveValue('');
});
it('tenant session cannot open operator navigation',async()=>{
  mockFetch({'GET /api/platform/workspaces':withStatus(401,{code:'UNAUTHENTICATED',message:'operator required',details:{}})});
  renderAt('/platform/health');
  await waitFor(()=>expect(screen.queryByRole('link',{name:'Ödeme bildirimleri'})).not.toBeInTheDocument());
  expect(await screen.findByLabelText(/E-posta/)).toBeInTheDocument();
});
