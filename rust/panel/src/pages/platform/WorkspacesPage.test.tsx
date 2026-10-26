import tr from '@/i18n/tr.json';
import { adminWorkspaces } from '@/test/fixtures';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';

const row = { id: 'workspace-1', name: 'Acme', slug: 'acme', owner_email: 'owner@example.test', member_count: 1, created_at: '2026-10-24T09:00:00Z' };
describe('explicit workspace transitions', () => {
  it('cannot activate a pending workspace with an operator status switch', async () => {
    mockFetch({ 'GET /api/platform/workspaces': [{ ...row, status: 'pending_payment' }] });
    renderAt('/platform/workspaces');
    await screen.findByText('Acme');
    expect(screen.queryByRole('button', { name: 'Etkinleştir' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yeniden aç' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Askıya al' })).toBeDisabled();
  });
  it('requires a reason and submits the explicit suspend endpoint', async () => {
    const calls = mockFetch({
      'GET /api/platform/workspaces': [{ ...row, status: 'active' }],
      'POST /api/platform/workspaces/workspace-1/suspend': { ...row, status: 'suspended' },
    });
    const user = userEvent.setup();
    renderAt('/platform/workspaces');
    await user.click(await screen.findByRole('button', { name: 'Askıya al' }));
    const submit = screen.getByRole('button', { name: 'Onayla' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Gerekçe'), 'operator review');
    await user.click(submit);
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ reason: 'operator review' }));
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });
});

// Preserve the original list/render contract alongside the new transition behavior.
describe('WorkspacesPage', () => {
  it('lists every workspace with its status actions', async () => {
    mockFetch({ 'GET /api/platform/workspaces': adminWorkspaces });
    renderAt('/platform/workspaces');
    expect(await screen.findByRole('heading', { level: 1, name: tr.platform.workspaces.title })).toBeInTheDocument();
    expect(await screen.findByText('alfa-atolye')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.platform.workspaces.resume })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.platform.workspaces.suspend })).toBeInTheDocument();
  });
});
