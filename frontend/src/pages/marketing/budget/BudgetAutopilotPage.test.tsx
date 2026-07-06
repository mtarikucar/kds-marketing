import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import BudgetAutopilotPage from './BudgetAutopilotPage';
import * as svc from '../../../features/marketing/api/growthBudget.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../features/marketing/api/growthBudget.service', () => ({
  listGrowthBudgets: vi.fn(),
  getGrowthBudget: vi.fn(),
  setBudgetKillSwitch: vi.fn(),
  setBudgetStatus: vi.fn(),
  setAutonomyLevel: vi.fn(),
  proposeBudget: vi.fn(),
  listAutopilotRuns: vi.fn().mockResolvedValue([]),
  listPendingApprovals: vi.fn().mockResolvedValue([]),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  applyReallocation: vi.fn(),
  getWalletState: vi.fn(),
  listBudgetActivity: vi.fn(),
  quickStart: vi.fn(),
  walletTopup: vi.fn(),
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
  scope: 'HOLISTIC', status: 'ACTIVE', killSwitch: false, explorationPct: 20, allocatorStage: 'MARGINAL', targetRoas: '2.5',
  targetCac: null, autonomyLevel: 'ASSISTED', contentAutoPublish: false, createdAt: '', updatedAt: '',
  allocations: [{ id: 'a1', channel: 'META', campaignRef: '', plannedAmount: '20000', spentAmount: '5000', marginalRoas: '3.2', lastPacedAt: null }],
};

const wallet = { workspaceId: 'ws1', balance: '10000', currency: 'TRY', exists: true };

const activity: svc.ActivityItem[] = [
  {
    ts: '2026-07-05T08:00:00.000Z',
    type: 'RUN',
    data: {
      id: 'r1', kind: 'REALLOCATION', autonomy: 'AUTO', ok: true, createdAt: '2026-07-05T08:00:00.000Z',
      objective: { channels: [{ channel: 'META', avgRoas: 3, marginalRoas: 2 }] },
      before: [{ channel: 'META', campaignRef: '', budget: 100 }],
      after: [{ channel: 'META', campaignRef: '', budget: 120, deltaPct: 20, reason: 'strong marginal ROAS' }],
    },
  },
];

describe('BudgetAutopilotPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (svc.getWalletState as any).mockResolvedValue(wallet);
    (svc.listBudgetActivity as any).mockResolvedValue(activity);
    (svc.listPendingApprovals as any).mockResolvedValue([]);
  });

  it('shows the empty state with the Enable Autopilot CTA when there is no budget', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No growth budget yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable Autopilot' })).toBeInTheDocument();
  });

  it('renders the hero strip: Growth Multiple + credit loaded/spent/balance from the wallet', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    renderPage();
    await waitFor(() => expect(screen.getByText('Growth Multiple')).toBeInTheDocument());
    // revenue = 5000 × 3 = 15000; spend = 5000 → multiple 3.00×
    expect(screen.getByText('3.00×')).toBeInTheDocument();
    expect(screen.getByText('Credit loaded')).toBeInTheDocument();
    expect(screen.getByText('Credit spent')).toBeInTheDocument();
    expect(screen.getByText('Credit balance')).toBeInTheDocument();
  });

  it('formats money in the budget currency + i18n locale (no hard tr-TR)', async () => {
    const usd = { ...budget, currency: 'USD' };
    (svc.listGrowthBudgets as any).mockResolvedValue([usd]);
    (svc.getGrowthBudget as any).mockResolvedValue(usd);
    (svc.getWalletState as any).mockResolvedValue({ ...wallet, currency: 'USD' });
    renderPage();
    await waitFor(() => expect(screen.getByText('Growth Multiple')).toBeInTheDocument());
    expect(screen.getAllByText(/\$/).length).toBeGreaterThan(0);
  });

  it('shows the Mode-1 honesty copy about ad billing', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(
          'Ad spend is billed by Meta/TikTok on your connected ad account; your credit governs how much the engine commits.',
        ),
      ).toBeInTheDocument(),
    );
  });

  it('renders the Approvals tab ONLY when the budget is ASSISTED', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    renderPage();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
  });

  it('hides the Approvals tab and shows the armed switch for an AUTONOMOUS budget', async () => {
    const auto = { ...budget, autonomyLevel: 'AUTONOMOUS' as const };
    (svc.listGrowthBudgets as any).mockResolvedValue([auto]);
    (svc.getGrowthBudget as any).mockResolvedValue(auto);
    renderPage();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Autopilot' })).toBeChecked());
    expect(screen.queryByRole('tab', { name: 'Approvals' })).not.toBeInTheDocument();
  });

  it('arms the autonomy lane through the ONE Autopilot switch', async () => {
    const user = userEvent.setup();
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    (svc.setAutonomyLevel as any).mockResolvedValue({ ...budget, autonomyLevel: 'AUTONOMOUS' });
    renderPage();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Autopilot' })).toBeInTheDocument());
    await user.click(screen.getByRole('switch', { name: 'Autopilot' }));
    await waitFor(() => expect(svc.setAutonomyLevel).toHaveBeenCalledWith('b1', 'AUTONOMOUS'));
  });

  it('explains + disables the switch when the platform flag rejects arming', async () => {
    const user = userEvent.setup();
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    (svc.setAutonomyLevel as any).mockRejectedValue({
      response: { status: 400, data: { message: 'Autonomous mode is not enabled on this platform' } },
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Autopilot' })).toBeInTheDocument());
    await user.click(screen.getByRole('switch', { name: 'Autopilot' }));
    await waitFor(() =>
      expect(screen.getByText('Autonomous mode is not enabled on this platform yet — ask your platform admin.')).toBeInTheDocument(),
    );
    expect(screen.getByRole('switch', { name: 'Autopilot' })).toBeDisabled();
  });

  it('renders the Activity Log feed', async () => {
    const user = userEvent.setup();
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    renderPage();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Autopilot rebalanced the budget')).toBeInTheDocument();
    expect(screen.getByText(/strong marginal ROAS/)).toBeInTheDocument();
  });

  it('pauses the engine with the Pause interrupt', async () => {
    const user = userEvent.setup();
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    (svc.setBudgetStatus as any).mockResolvedValue({ ...budget, status: 'PAUSED' });
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(svc.setBudgetStatus).toHaveBeenCalledWith('b1', 'PAUSED'));
  });
});
