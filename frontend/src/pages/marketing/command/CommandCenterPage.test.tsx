import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CommandCenterPage from './CommandCenterPage';
import * as commandService from '../../../features/marketing/api/command.service';
import * as budgetService from '../../../features/marketing/api/growthBudget.service';
import * as timelineService from '../../../features/marketing/api/homeTimeline.service';

vi.mock('../../../features/marketing/api/command.service');
vi.mock('../../../features/marketing/api/growthBudget.service');
// The left column mounts TimelinePanel, which fetches on its own. Stubbed so
// this stays a test of the PAGE and not a second, weaker test of the panel.
vi.mock('../../../features/marketing/api/homeTimeline.service');
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: any) => sel({ user: { firstName: 'Tarık', role: 'OWNER' } }),
}));

const runCommand = vi.mocked(commandService.runCommand);
const listAgentRuns = vi.mocked(commandService.listAgentRuns);
const listPendingApprovals = vi.mocked(budgetService.listPendingApprovals);
const getHomeTimeline = vi.mocked(timelineService.getHomeTimeline);

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
  getHomeTimeline.mockResolvedValue({
    from: '', to: '', items: [], unread: [], truncated: [], research: null,
  });
});

describe('CommandCenterPage', () => {
  it('renders two columns: the tabbed left panel and the chat', () => {
    renderPage();
    // Asserted by CONTENT, not just by the wrapper: an empty <section> with the
    // right testid is the mutation this test has to catch.
    expect(within(screen.getByTestId('home-left')).getByRole('tablist')).toBeInTheDocument();
    expect(within(screen.getByTestId('home-chat')).getByTestId('command-bar')).toBeInTheDocument();
  });

  // The one line this whole screen was defined by: the hook's count reaching
  // the column. `failureCount={0}` typechecks, keeps every other test on this
  // page green and is EXACTLY the failure LeftColumn's docblock warns about —
  // a column that looks instrumented and reports nothing. Asserted end to end
  // (a FAILED run in the API mock, a lit badge on screen) rather than by
  // spying on the hook, because the wire is the thing under test.
  it('carries a real failure from the API through to the badge on the tab strip', async () => {
    listAgentRuns.mockResolvedValue([
      {
        id: 'r-bad', goal: 'reklam bütçesini artır', agent: 'growth', status: 'FAILED',
        startedAt: new Date().toISOString(), toolCalls: [],
      },
    ] as never);
    renderPage();

    // The flow tab is not even mounted — that is the point of the badge.
    expect(await screen.findByTestId('flow-badge')).toHaveTextContent('1');
  });

  // AgentActivity is the flow TAB's content now. Rendering it standalone as
  // well would show the same list twice on one screen, which is exactly what
  // the left column exists to stop.
  it('shows the agent flow only inside the left column, never twice', async () => {
    const user = userEvent.setup();
    listAgentRuns.mockResolvedValue([
      {
        id: 'r1', goal: 'kampanya kur', agent: 'growth', status: 'DONE',
        startedAt: new Date().toISOString(), toolCalls: [],
      },
    ] as never);
    renderPage();

    // Calendar tab is the default, so the flow is not on screen at all yet.
    expect(screen.queryByText('kampanya kur')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Ak/ }));
    expect(await screen.findAllByText('kampanya kur')).toHaveLength(1);
  });

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
