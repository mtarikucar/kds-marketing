import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
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
    expect(screen.getByRole('columnheader', { name: tr.agents.columns.checkin })).toBeInTheDocument();
  });

  it('flags each connection that is overdue for its check-in', async () => {
    const late = {
      ...agents[0],
      id: '0190a000-0000-7000-8000-000000000031',
      client_name: 'gec-istemci',
      overdue: true,
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/agents': [agents[0], late] });
    renderAt('/agents');
    const lateRow = (await screen.findByText('gec-istemci')).closest('tr');
    const onTimeRow = screen.getByText('ornek-istemci').closest('tr');
    expect(lateRow).not.toBeNull();
    expect(onTimeRow).not.toBeNull();
    expect(within(lateRow as HTMLElement).getByText(tr.agents.overdue)).toBeInTheDocument();
    expect(within(onTimeRow as HTMLElement).getByText(tr.agents.onTime)).toBeInTheDocument();
    expect(within(onTimeRow as HTMLElement).queryByText(tr.agents.overdue)).not.toBeInTheDocument();
  });
});
