import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { me, workspace } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('HomePage', () => {
  it('shows the workspace, its status and the strategy placeholder', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: tr.home.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: workspace.name })).toBeInTheDocument();
    expect(screen.getAllByText(tr.status.workspace.pending_payment).length).toBeGreaterThan(0);
    expect(screen.getByText(tr.home.strategy.title)).toBeInTheDocument();
  });
});
