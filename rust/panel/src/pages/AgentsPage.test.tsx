import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { agents, me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

describe('AgentsPage', () => {
  it('lists the agent connections', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': agents });
    renderAt('/agents');
    expect(await screen.findByRole('heading', { level: 1, name: tr.agents.title })).toBeInTheDocument();
    expect(await screen.findByText('ornek-istemci')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});
