import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CommandCenterPage from './CommandCenterPage';
import * as commandService from '../../../features/marketing/api/command.service';
import * as budgetService from '../../../features/marketing/api/growthBudget.service';
import marketingApi from '../../../features/marketing/api/marketingApi';

vi.mock('../../../features/marketing/api/command.service');
vi.mock('../../../features/marketing/api/growthBudget.service');
vi.mock('../../../features/marketing/api/marketingApi');
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: any) => sel({ user: { firstName: 'Tarık', role: 'OWNER' } }),
}));

const runCommand = vi.mocked(commandService.runCommand);
const listAgentRuns = vi.mocked(commandService.listAgentRuns);
const listPendingApprovals = vi.mocked(budgetService.listPendingApprovals);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CommandCenterPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  listAgentRuns.mockResolvedValue([]);
  listPendingApprovals.mockResolvedValue([] as never);
  vi.mocked(marketingApi.get).mockResolvedValue({ data: { totalLeads: 325 } } as never);
});

describe('CommandCenterPage', () => {
  it('runs a typed command and reports what it did', async () => {
    const user = userEvent.setup();
    runCommand.mockResolvedValue({
      answer: '3 gönderi taslağı hazırladım.',
      actions: [{ tool: 'jeeta.draft_social_post', status: 'OK' }],
      runId: 'run-1',
    });
    renderPage();

    await user.type(await screen.findByRole('textbox'), 'eylül için 3 gönderi hazırla');
    await user.click(screen.getByRole('button', { name: /Çalıştır/ }));

    // react-query hands the mutationFn a second context argument; only the
    // command itself is ours to assert.
    expect(runCommand.mock.calls[0][0]).toBe('eylül için 3 gönderi hazırla');
    expect(await screen.findByText('3 gönderi taslağı hazırladım.')).toBeInTheDocument();
    // The prose is the model's; the chip is the record of what actually ran.
    expect(screen.getByText('draft_social_post')).toBeInTheDocument();
  });

  it('shows a queued action as pending, so a gated call is never read as done', async () => {
    const user = userEvent.setup();
    runCommand.mockResolvedValue({
      answer: 'Onayına sundum.',
      actions: [
        { tool: 'jeeta.publish_social_post', status: 'PENDING_APPROVAL', approvalId: 'ap-1' },
      ],
      runId: 'run-2',
    });
    renderPage();

    await user.type(await screen.findByRole('textbox'), 'yayınla');
    await user.click(screen.getByRole('button', { name: /Çalıştır/ }));

    const chip = await screen.findByText('publish_social_post');
    expect(chip.closest('li')).toHaveClass('text-warning');
  });

  it('surfaces a failed command instead of leaving it spinning', async () => {
    const user = userEvent.setup();
    runCommand.mockRejectedValue({ response: { data: { message: 'AI is not configured' } } });
    renderPage();

    await user.type(await screen.findByRole('textbox'), 'bir şey yap');
    await user.click(screen.getByRole('button', { name: /Çalıştır/ }));

    expect(await screen.findByText('AI is not configured')).toBeInTheDocument();
  });

  it('hides the approvals box when nothing is waiting', async () => {
    renderPage();
    await screen.findByRole('textbox');
    // A permanently empty "Approvals" panel teaches people to skip the one
    // section that must never be skipped.
    expect(screen.queryByText('Onayını bekliyor')).not.toBeInTheDocument();
  });

  it('shows the approvals box, with a count, when the agent is waiting on a human', async () => {
    listPendingApprovals.mockResolvedValue([
      { id: 'a1', kind: 'PUBLISH', summary: 'Yayın onayı', createdAt: new Date().toISOString() },
      { id: 'a2', kind: 'AD_SPEND', summary: 'Bütçe', createdAt: new Date().toISOString() },
    ] as never);
    renderPage();

    expect(await screen.findByText('Onayını bekliyor')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
