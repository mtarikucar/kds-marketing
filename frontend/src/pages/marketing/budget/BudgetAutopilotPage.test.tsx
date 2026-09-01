import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import BudgetAutopilotPage from './BudgetAutopilotPage';
import * as svc from '../../../features/marketing/api/growthBudget.service';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../features/marketing/api/growthBudget.service', async () => {
  // isMcpApprovalPayload is a real (unmocked) pure function the page relies on
  // to discriminate MCP-originated approvals from Budget Autopilot ones —
  // keep the real implementation, only stub the network calls.
  const actual = await vi.importActual<typeof import('../../../features/marketing/api/growthBudget.service')>(
    '../../../features/marketing/api/growthBudget.service',
  );
  return {
    ...actual,
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
    applyRequest: vi.fn(),
    getWalletState: vi.fn(),
    listBudgetActivity: vi.fn(),
    quickStart: vi.fn(),
    walletTopup: vi.fn(),
  };
});

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

const mcpApproval: svc.ApprovalRequest = {
  id: 'ap-mcp-1',
  kind: 'SEND',
  status: 'PENDING',
  summary: 'MCP agent requested "jeeta.send_message"',
  payload: { tool: 'jeeta.send_message', args: { to: '+905551234567', body: 'Your order has shipped!' } },
  resourceType: null,
  resourceId: null,
  createdAt: '2026-07-20T10:00:00.000Z',
};

const reallocationApproval: svc.ApprovalRequest = {
  id: 'ap-realloc-1',
  kind: 'BUDGET_REALLOCATION',
  status: 'PENDING',
  summary: 'Reallocate 2 channel(s) within budget pool 1000',
  payload: { budgetId: 'b1', runId: 'run1', after: [{ channel: 'META', budget: 500 }] },
  resourceType: 'growth_budget',
  resourceId: 'b1',
  createdAt: '2026-07-20T10:00:00.000Z',
};

// A previous apply attempt failed after approve succeeded (or the tab closed
// between the two calls) — the backend now keeps this visible as APPROVED
// instead of dropping it from the PENDING-only queue.
const mcpApprovalApprovedUnapplied: svc.ApprovalRequest = { ...mcpApproval, id: 'ap-mcp-2', status: 'APPROVED' };

/**
 * The store is module-global and survives between tests, so the role has to be
 * set rather than assumed. It matters here because ApprovalQueue now withholds
 * Approve/Reject/Apply below MANAGER: every decision route is
 * `@MarketingRoles('MANAGER')`, so an ungated button could only ever 403.
 * MANAGER is the honest default for this page — it is a manager surface in the
 * nav — and the owner-only top-up block below overrides it deliberately.
 */
function setRole(role: 'OWNER' | 'MANAGER' | 'REP') {
  useMarketingAuthStore.setState({
    user: { id: 'u1', workspaceId: 'ws1', email: 'a@b.c', firstName: 'A', lastName: 'B', role },
  });
}

describe('BudgetAutopilotPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole('MANAGER');
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

  it('says the wallet could not be read instead of printing a fabricated zero', async () => {
    /**
     * The wallet read has no error boundary — its only consumers are the two
     * hero tiles — so a failure used to render as `money(0)`: a real currency
     * amount asserting the workspace is out of credit, when the truth is that
     * we could not ask. Silencing the query (so the global toaster stops
     * shouting over the two inline error states this page already has) made
     * that worse, not better: no report anywhere, and a number confident
     * enough to act on.
     */
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    (svc.getWalletState as any).mockRejectedValue(new Error('wallet unavailable'));
    renderPage();

    await waitFor(() => expect(screen.getByText('Credit balance')).toBeInTheDocument());
    // This file's i18n mock returns the INLINE default, which is the Turkish
    // 'okunamadı' — the same key and default the Studio's status bar uses, so
    // the two surfaces cannot drift into saying different things about the
    // same failure. The English catalogue carries "couldn't be read".
    expect(screen.getAllByText('okunamadı').length).toBe(2);
    // The two wallet-derived tiles must not print a currency figure at all.
    // "Credit spent" comes from the allocations and is unaffected, so this
    // asserts on the absence of a ZERO rather than of all money.
    expect(screen.queryByText(/(^|\s)(₺|\$)\s?0([.,]00)?$/)).not.toBeInTheDocument();
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

  describe('Approvals — MCP vs. Budget Reallocation routing', () => {
    it('renders the MCP tool name and its arguments so the operator sees what they are approving', async () => {
      const user = userEvent.setup();
      (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
      (svc.getGrowthBudget as any).mockResolvedValue(budget);
      (svc.listPendingApprovals as any).mockResolvedValue([mcpApproval]);
      renderPage();
      await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Approvals' }));

      expect(await screen.findByText('jeeta.send_message')).toBeInTheDocument();
      expect(screen.getByText('+905551234567')).toBeInTheDocument();
      expect(screen.getByText('Your order has shipped!')).toBeInTheDocument();
    });

    it('an MCP-originated approval triggers approve, then apply', async () => {
      const user = userEvent.setup();
      (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
      (svc.getGrowthBudget as any).mockResolvedValue(budget);
      (svc.listPendingApprovals as any).mockResolvedValue([mcpApproval]);
      (svc.approveRequest as any).mockResolvedValue({});
      (svc.applyRequest as any).mockResolvedValue({ status: 'APPLIED', result: { sent: true } });
      renderPage();
      await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Approvals' }));
      await screen.findByText('jeeta.send_message');

      await user.click(screen.getByRole('button', { name: 'Approve' }));

      await waitFor(() => expect(svc.applyRequest).toHaveBeenCalledWith('ap-mcp-1'));
      expect(svc.approveRequest).toHaveBeenCalledWith('ap-mcp-1');
      expect(svc.applyReallocation).not.toHaveBeenCalled();
      // approve must happen before apply — apply-without-approve is the exact
      // gap this task closes.
      const approveOrder = (svc.approveRequest as any).mock.invocationCallOrder[0];
      const applyOrder = (svc.applyRequest as any).mock.invocationCallOrder[0];
      expect(approveOrder).toBeLessThan(applyOrder);
    });

    it('a BUDGET_REALLOCATION from the Budget Autopilot still goes through applyReallocation, and only that', async () => {
      const user = userEvent.setup();
      (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
      (svc.getGrowthBudget as any).mockResolvedValue(budget);
      (svc.listPendingApprovals as any).mockResolvedValue([reallocationApproval]);
      (svc.applyReallocation as any).mockResolvedValue({ status: 'APPLIED', applied: 1, skipped: 0 });
      renderPage();
      await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Approvals' }));
      await screen.findByText('Reallocate 2 channel(s) within budget pool 1000');

      await user.click(screen.getByRole('button', { name: 'Approve' }));
      // BUDGET_REALLOCATION confirms before pushing live.
      await user.click(await screen.findByRole('button', { name: 'Approve & push live' }));

      await waitFor(() => expect(svc.applyReallocation).toHaveBeenCalledWith('ap-realloc-1'));
      expect(svc.approveRequest).not.toHaveBeenCalled();
      expect(svc.applyRequest).not.toHaveBeenCalled();
    });
  });

  describe('Approvals — APPROVED-but-unapplied retry (fix round 1)', () => {
    it('renders an APPROVED-unapplied row with an Apply affordance, not Approve/Reject, and applying it does not re-approve', async () => {
      const user = userEvent.setup();
      (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
      (svc.getGrowthBudget as any).mockResolvedValue(budget);
      (svc.listPendingApprovals as any).mockResolvedValue([mcpApprovalApprovedUnapplied]);
      (svc.applyRequest as any).mockResolvedValue({ status: 'APPLIED', result: { sent: true } });
      renderPage();
      await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Approvals' }));
      await screen.findByText('jeeta.send_message');

      expect(screen.getByText('Approved — not applied yet')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(svc.applyRequest).toHaveBeenCalledWith('ap-mcp-2'));
      expect(svc.approveRequest).not.toHaveBeenCalled();
    });

    it('tells the operator the decision was recorded (and applying failed) when apply throws after approve succeeds', async () => {
      const user = userEvent.setup();
      const { toast } = await import('sonner');
      (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
      (svc.getGrowthBudget as any).mockResolvedValue(budget);
      (svc.listPendingApprovals as any).mockResolvedValue([mcpApproval]);
      (svc.approveRequest as any).mockResolvedValue({});
      (svc.applyRequest as any).mockRejectedValue({ response: { data: { message: 'tool call failed' } } });
      renderPage();
      await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Approvals' }));
      await screen.findByText('jeeta.send_message');

      await user.click(screen.getByRole('button', { name: 'Approve' }));

      await waitFor(() => expect(svc.applyRequest).toHaveBeenCalledWith('ap-mcp-1'));
      expect(svc.approveRequest).toHaveBeenCalledWith('ap-mcp-1');
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Approved — but applying it failed. The decision was recorded; retry Apply to finish it.',
        ),
      );
      // Never the generic (and here false) message — the decision WAS recorded.
      expect(toast.error).not.toHaveBeenCalledWith('Could not record your decision');
    });

    it('an APPROVED-unapplied BUDGET_REALLOCATION still routes through applyReallocation via the same confirm dialog', async () => {
      const user = userEvent.setup();
      const approvedRealloc = { ...reallocationApproval, status: 'APPROVED' };
      (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
      (svc.getGrowthBudget as any).mockResolvedValue(budget);
      (svc.listPendingApprovals as any).mockResolvedValue([approvedRealloc]);
      (svc.applyReallocation as any).mockResolvedValue({ status: 'APPLIED', applied: 1, skipped: 0 });
      renderPage();
      await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Approvals' }));
      await screen.findByText('Reallocate 2 channel(s) within budget pool 1000');

      expect(screen.getByText('Approved — not applied yet')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Apply' }));
      await user.click(await screen.findByRole('button', { name: 'Approve & push live' }));

      await waitFor(() => expect(svc.applyReallocation).toHaveBeenCalledWith('ap-realloc-1'));
      expect(svc.approveRequest).not.toHaveBeenCalled();
      expect(svc.applyRequest).not.toHaveBeenCalled();
    });
  });
});

/**
 * Approvals are WORKSPACE-scoped, but the Approvals tab lives inside the budget
 * detail — so it vanishes with no budget, and again when the budget is armed.
 * That was fine while the queue only held Autopilot's own proposals. The MCP
 * broker now enqueues one for every gated tool a connected agent calls, and
 * SPEND/DESTRUCTIVE stay gated in EVERY write mode — so those two cases left
 * real approvals with no screen to decide them, expiring unseen after the TTL.
 */
describe('BudgetAutopilotPage — approvals must never be unreachable', () => {
  beforeEach(() => setRole('MANAGER'));

  const mcpApproval = {
    id: 'ap-1',
    kind: 'AI_SPEND',
    summary: 'MCP agent requested "jeeta.synthesize_strategy"',
    payload: { tool: 'jeeta.synthesize_strategy', args: {} },
    createdAt: new Date().toISOString(),
  };

  it('surfaces a pending approval when there is NO growth budget', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    (svc.listPendingApprovals as any).mockResolvedValue([mcpApproval]);

    renderPage();

    // The empty budget state still shows — but it is no longer the whole page.
    expect(await screen.findByText('No growth budget yet')).toBeInTheDocument();
    // The queue itself is what matters here; how one card renders is the
    // ApprovalsTab's own concern and is covered by its existing tests.
    expect(await screen.findByTestId('standalone-approvals')).toBeInTheDocument();
  });

  it('surfaces a pending approval when the budget is ARMED (tab is gone)', async () => {
    const auto = { ...budget, autonomyLevel: 'AUTONOMOUS' as const };
    (svc.listGrowthBudgets as any).mockResolvedValue([auto]);
    (svc.getGrowthBudget as any).mockResolvedValue(auto);
    (svc.listPendingApprovals as any).mockResolvedValue([mcpApproval]);

    renderPage();

    // Armed removes the tab; SPEND approvals still arrive, so the queue must
    // appear at page level instead of silently disappearing.
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Approvals' })).not.toBeInTheDocument());
    expect(await screen.findByTestId('standalone-approvals')).toBeInTheDocument();
  });

  it('does not render the standalone queue when nothing is waiting', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([]);
    (svc.listPendingApprovals as any).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText('No growth budget yet')).toBeInTheDocument();
    expect(screen.queryByTestId('standalone-approvals')).not.toBeInTheDocument();
  });

  it('leaves the tab in sole charge when an unarmed budget exists (no double render)', async () => {
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    (svc.listPendingApprovals as any).mockResolvedValue([mcpApproval]);

    renderPage();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' })).toBeInTheDocument());
    expect(screen.queryByTestId('standalone-approvals')).not.toBeInTheDocument();
  });
});

/**
 * POST /billing/wallet-topup is @MarketingRoles('OWNER'). The Top-up button
 * carried no owner gate, so for a MANAGER it was a visible, enabled money
 * button whose every click was a guaranteed 403 rendered as "Could not start
 * the top-up".
 */
describe('BudgetAutopilotPage — the wallet top-up is owner-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (svc.getWalletState as any).mockResolvedValue(wallet);
    (svc.listBudgetActivity as any).mockResolvedValue(activity);
    (svc.listPendingApprovals as any).mockResolvedValue([]);
    (svc.listGrowthBudgets as any).mockResolvedValue([budget]);
    (svc.getGrowthBudget as any).mockResolvedValue(budget);
    (svc.walletTopup as any).mockResolvedValue({ handle: { url: 'https://pay' } });
  });

  it('does not let a MANAGER fire a top-up that can only 403', async () => {
    setRole('MANAGER');
    renderPage();

    const button = await screen.findByRole('button', { name: /owner only/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(svc.walletTopup).not.toHaveBeenCalled();
    expect(screen.getByText(/only the workspace owner can top up/i)).toBeInTheDocument();
  });

  it('still lets an OWNER top up', async () => {
    setRole('OWNER');
    renderPage();

    const button = await screen.findByRole('button', { name: /top up/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(svc.walletTopup).toHaveBeenCalled());
  });
});
