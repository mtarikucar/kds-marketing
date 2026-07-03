import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import BudgetAutopilotPage from './BudgetAutopilotPage';
import * as svc from '../../../features/marketing/api/growthBudget.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
  }),
}));

vi.mock('../../../features/marketing/api/growthBudget.service', () => ({
  listGrowthBudgets: vi.fn(),
  getGrowthBudget: vi.fn(),
  setBudgetKillSwitch: vi.fn(),
  proposeBudget: vi.fn(),
  listAutopilotRuns: vi.fn().mockResolvedValue([]),
  listPendingApprovals: vi.fn().mockResolvedValue([]),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BudgetAutopilotPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const budget: svc.GrowthBudget = {
  id: 'b1', workspaceId: 'ws1', periodKey: '2026-07', currency: 'TRY', totalAmount: '30000',
  scope: 'HOLISTIC', status: 'ACTIVE', killSwitch: false, explorationPct: 20, targetRoas: '2.5',
  targetCac: null, createdAt: '', updatedAt: '',
  allocations: [{ id: 'a1', channel: 'META', campaignRef: '', plannedAmount: '20000', spentAmount: '5000', marginalRoas: '3.2', lastPacedAt: null }],
};

describe('BudgetAutopilotPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty state when there is no budget', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No growth budget yet')).toBeInTheDocument();
  });

  it('renders the budget stat cards + status when a budget exists', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    renderPage();
    await waitFor(() => expect(screen.getByText('Monthly budget')).toBeInTheDocument());
    expect(screen.getByText('Exploration reserve')).toBeInTheDocument();
    // status badge + period surfaced
    expect(screen.getByText('2026-07')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });
});
