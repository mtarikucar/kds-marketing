import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalQueue } from './ApprovalQueue';
import * as budgetService from '../api/growthBudget.service';
import type { ApprovalRequest } from '../api/growthBudget.service';

vi.mock('../api/growthBudget.service', async (orig) => ({
  // isMcpApprovalPayload is the pure discriminator the three decision lanes
  // hang off — it is part of what is under test, so only the calls are mocked.
  ...(await orig<typeof budgetService>()),
  listPendingApprovals: vi.fn(),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  applyRequest: vi.fn(),
  applyReallocation: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The inline default is what actually renders in this product, so the
    // assertions below are on copy rather than on key names.
    t: (_k: string, d?: string | Record<string, unknown>) =>
      typeof d === 'string' ? d : ((d?.defaultValue as string) ?? ''),
  }),
}));

const mockRole = vi.fn(() => 'MANAGER' as string | undefined);
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: mockRole() } }),
}));

const listPendingApprovals = vi.mocked(budgetService.listPendingApprovals);
const approveRequest = vi.mocked(budgetService.approveRequest);
const rejectRequest = vi.mocked(budgetService.rejectRequest);

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'ar-1',
  kind: 'MCP_TOOL_CALL',
  status: 'PENDING',
  summary: 'Send a WhatsApp message to 41 leads',
  payload: { tool: 'jeeta.send_message', args: { channel: 'WHATSAPP', count: 41 } },
  resourceType: null,
  resourceId: null,
  createdAt: '2026-09-01T08:00:00Z',
  ...over,
});

function renderQueue(ui: ReactNode = <ApprovalQueue />) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockReturnValue('MANAGER');
  listPendingApprovals.mockResolvedValue([request()]);
});

/**
 * GET /marketing/approvals is `reports.read`; approve, reject and apply are all
 * `@MarketingRoles('MANAGER')` + `settings.manage`. So the queue is READ by a
 * rep on purpose and DECIDED by a manager only — and until 2026-09-01 the
 * component honoured only the first half of that, on /home (CommandCenterPage)
 * and on the Growth Studio's right rail (TodayQueuePanel).
 */
describe('ApprovalQueue — who may decide', () => {
  it('withholds every decision button from a REP, and says why', async () => {
    mockRole.mockReturnValue('REP');
    renderQueue();

    await screen.findByText('Send a WhatsApp message to 41 leads');
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('approvals-readonly')).toBeInTheDocument();
  });

  it('still SHOWS a rep the row and the tool it would run', async () => {
    // The read is deliberate: withholding the decision must not withhold the
    // disclosure, or a rep can no longer see what the agent is about to send
    // into their own conversations.
    mockRole.mockReturnValue('REP');
    renderQueue();

    expect(await screen.findByText('jeeta.send_message')).toBeInTheDocument();
    expect(screen.getByText('WHATSAPP')).toBeInTheDocument();
  });

  it('gives a MANAGER both buttons, and they still work', async () => {
    const user = userEvent.setup();
    renderQueue();

    await user.click(await screen.findByRole('button', { name: /Reject/ }));
    // First arg only: React Query hands the mutationFn a context object second.
    expect(rejectRequest.mock.calls[0][0]).toBe('ar-1');
    expect(screen.queryByTestId('approvals-readonly')).not.toBeInTheDocument();
  });

  it('keeps the reallocation confirm dialog behind the manager gate', async () => {
    // The one row whose Approve opens a dialog rather than firing — a rep must
    // not be able to reach it at all, since applying moves real ad spend.
    const user = userEvent.setup();
    listPendingApprovals.mockResolvedValue([
      request({ id: 'ar-2', kind: 'BUDGET_REALLOCATION', payload: { moves: [] }, summary: 'Shift 400 TRY to Meta' }),
    ]);
    renderQueue();

    await user.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText('Push this reallocation live?')).toBeInTheDocument();
    expect(approveRequest).not.toHaveBeenCalled();
  });

  it('offers a rep no Apply affordance on an APPROVED-unapplied row either', async () => {
    // The retry lane: `status: 'APPROVED'` swaps Approve for Apply, which is
    // the same MANAGER route. Gating only the PENDING shape would have left
    // this one button standing.
    mockRole.mockReturnValue('REP');
    listPendingApprovals.mockResolvedValue([request({ status: 'APPROVED' })]);
    renderQueue();

    await screen.findByText('Send a WhatsApp message to 41 leads');
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('approvals-readonly')).toBeInTheDocument();
  });
});
