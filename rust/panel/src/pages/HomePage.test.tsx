import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { me, pendingOverdue, repMe, workspace } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('HomePage', () => {
  it('shows the workspace, its status and the missing strategy with its call to action', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': pendingOverdue });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: tr.home.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: workspace.name })).toBeInTheDocument();
    expect(screen.getAllByText(tr.status.workspace.pending_payment).length).toBeGreaterThan(0);
    expect(await screen.findByText(tr.home.strategy.title)).toBeInTheDocument();
    expect(screen.getByText(tr.home.strategy.body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.home.strategy.start })).toBeInTheDocument();
  });

  it('warns in red when the agent is overdue, and lists each pending item in its own words', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': pendingOverdue });
    renderAt('/');
    const warning = await screen.findByText(tr.home.agent.overdueTitle);
    expect(warning.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText(tr.home.agent.schedulerNote)).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('home.pending.verify_capability_stale', { name: 'Ofis yazıcısı' })),
    ).toBeInTheDocument();
    expect(screen.getByText(tr.home.pending.consult_strategy)).toBeInTheDocument();
    // The agent's English hint is for the agent, never shown.
    expect(screen.queryByText('verify it again')).not.toBeInTheDocument();
  });

  it('offers the approval shortcut only to someone who may approve', async () => {
    const submitted = { ...pendingOverdue, strategy: 'submitted' as const };
    mockFetch({ 'GET /api/auth/me': repMe, 'GET /api/workspace': workspace, 'GET /api/work/pending': submitted });
    renderAt('/');
    expect(await screen.findByText(tr.home.strategy.submittedTitle)).toBeInTheDocument();
    expect(screen.getByText(tr.home.strategy.submittedWait)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.home.strategy.approve })).not.toBeInTheDocument();
  });

  it('shows the draft gaps and the version in force', async () => {
    const draft = {
      ...pendingOverdue,
      strategy: { draft_open: { gaps: [{ field: 'identity.product', message: 'the product is required' }] } },
      agent: { ...pendingOverdue.agent, overdue: false },
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': draft });
    renderAt('/');
    expect(await screen.findByText(tr.home.strategy.draftTitle)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('home.strategy.draftBody', { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText('the product is required')).toBeInTheDocument();
    expect(screen.queryByText(tr.home.agent.overdueTitle)).not.toBeInTheDocument();
    expect(screen.getByText(tr.home.agent.onTime)).toBeInTheDocument();
  });
});
