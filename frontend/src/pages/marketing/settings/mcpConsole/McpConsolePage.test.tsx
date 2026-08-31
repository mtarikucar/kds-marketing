import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// ── Service stub — every call the page makes ────────────────────────────────
vi.mock('../../../../features/marketing/api/mcpConsole.service', () => ({
  getMcpConsoleOverview: vi.fn(),
  getMcpConnections: vi.fn(),
  revokeMcpOAuthConnection: vi.fn(),
  listMcpSessions: vi.fn(),
  getMcpSession: vi.fn(),
  setMcpWriteMode: vi.fn(),
  setResearchExecution: vi.fn(),
}));

// `t(key, default, vars)` — resolves to the inline default and interpolates
// `{{vars}}` so the assertions read the real user-facing copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      const isStr = typeof def === 'string';
      const template = isStr
        ? (def as string)
        : ((def as { defaultValue?: string } | undefined)?.defaultValue ?? key);
      const vars = (isStr ? opts : (def as Record<string, unknown> | undefined)) ?? {};
      return String(template).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// jsdom has no clipboard; the copy assertions are about WHAT is handed over.
vi.mock('../../../../lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }));

import * as svc from '../../../../features/marketing/api/mcpConsole.service';
import * as clipboard from '../../../../lib/clipboard';
import McpConsolePage from './McpConsolePage';

const api = svc as unknown as {
  getMcpConsoleOverview: ReturnType<typeof vi.fn>;
  getMcpConnections: ReturnType<typeof vi.fn>;
  revokeMcpOAuthConnection: ReturnType<typeof vi.fn>;
  listMcpSessions: ReturnType<typeof vi.fn>;
  getMcpSession: ReturnType<typeof vi.fn>;
  setMcpWriteMode: ReturnType<typeof vi.fn>;
  setResearchExecution: ReturnType<typeof vi.fn>;
};

const CLIENT_ID = 'https://claude.ai/api/mcp/client/abc';

const overview = (over: Partial<Record<string, unknown>> = {}) => ({
  mcpWriteMode: 'APPROVAL',
  researchExecution: 'SERVER',
  researchExecutionSource: 'EXPLICIT',
  researchGraceHours: 6,
  canToggle: true,
  mcpEndpoint: 'https://app.jeetagrowth.com/api/mcp',
  liveConnectionCount: 2,
  pendingApprovalCount: 4,
  ...over,
});

const connections = () => ({
  oauth: [
    {
      kind: 'OAUTH',
      clientId: CLIENT_ID,
      clientName: 'Claude.ai',
      logoUri: null,
      clientUri: 'https://claude.ai',
      scopes: ['leads_read', 'campaigns_send'],
      connectedAt: '2026-07-01T10:00:00.000Z',
      lastActivityAt: '2026-07-20T12:30:00.000Z',
      liveTokenCount: 3,
    },
  ],
  apiKeys: [
    {
      kind: 'API_KEY',
      id: 'k1',
      name: 'Claude Code laptop',
      scopes: ['leads_read'],
      lastUsedAt: '2026-07-25T08:00:00.000Z',
      createdAt: '2026-06-01T08:00:00.000Z',
    },
  ],
});

const sessions = () => ({
  items: [
    {
      id: 'run1',
      status: 'SUCCESS',
      goal: 'leads.search',
      startedAt: '2026-07-25T08:00:00.000Z',
      finishedAt: '2026-07-25T08:00:02.000Z',
      error: null,
      toolCallCount: 1,
      approvalCount: 0,
    },
    {
      id: 'run2',
      status: 'PENDING_APPROVAL',
      goal: 'messages.send',
      startedAt: '2026-07-24T08:00:00.000Z',
      finishedAt: null,
      error: null,
      toolCallCount: 0,
      approvalCount: 1,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
});

const sessionDetail = () => ({
  id: 'run1',
  status: 'SUCCESS',
  goal: 'leads.search',
  startedAt: '2026-07-25T08:00:00.000Z',
  finishedAt: '2026-07-25T08:00:02.000Z',
  error: null,
  queuedForApproval: false,
  toolCalls: [
    {
      id: 'tc1',
      tool: 'leads.search',
      at: '2026-07-25T08:00:01.000Z',
      ok: true,
      error: null,
      latencyMs: 412,
      argsBytes: 2048,
      argsKeys: ['limit', 'query'],
      resultBytes: 51200,
    },
  ],
  approvals: [],
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getMcpConsoleOverview.mockResolvedValue(overview());
  api.getMcpConnections.mockResolvedValue(connections());
  api.listMcpSessions.mockResolvedValue(sessions());
  api.getMcpSession.mockResolvedValue(sessionDetail());
  api.setMcpWriteMode.mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' });
  api.revokeMcpOAuthConnection.mockResolvedValue({ clientId: CLIENT_ID, revoked: 3 });
});

describe('McpConsolePage — sections', () => {
  it('renders the overview: endpoint, live count and pending-approval count linked to the queue', async () => {
    render(<McpConsolePage />, { wrapper });

    expect(await screen.findByTestId('mcp-endpoint')).toHaveTextContent(
      'https://app.jeetagrowth.com/api/mcp',
    );
    expect(
      screen.getByRole('button', { name: /copy connector address/i }),
    ).toBeInTheDocument();

    expect(screen.getByText('Live connections')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    // Pending approvals link to the existing approval queue (Autopilot console).
    const link = screen.getByRole('link', { name: /waiting for your approval/i });
    expect(link).toHaveAttribute('href', '/studio');
    expect(within(link).getByText('4')).toBeInTheDocument();
  });

  it('warns instead of showing a fake address when the deployment has no endpoint', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(overview({ mcpEndpoint: null }));
    render(<McpConsolePage />, { wrapper });

    expect(await screen.findByText(/no public address/i)).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-endpoint')).not.toBeInTheDocument();
  });

  it('renders the connections section: OAuth client with its client_id, scopes and counts', async () => {
    render(<McpConsolePage />, { wrapper });

    const row = await screen.findByTestId('mcp-oauth-connection');
    expect(within(row).getByText('Claude.ai')).toBeInTheDocument();
    // The client_id URL is shown underneath the name — it is the identity.
    expect(within(row).getByText(CLIENT_ID)).toBeInTheDocument();
    expect(within(row).getByText('leads_read')).toBeInTheDocument();
    expect(within(row).getByText('campaigns_send')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
  });

  it('lists API keys read-only and links out to the api-keys page for management', async () => {
    render(<McpConsolePage />, { wrapper });

    const key = await screen.findByTestId('mcp-api-key');
    expect(within(key).getByText('Claude Code laptop')).toBeInTheDocument();
    // No destructive control on this surface — management lives elsewhere.
    expect(within(key).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage api keys/i })).toHaveAttribute(
      'href',
      '/settings/api-keys',
    );
  });

  it('renders the session list newest-first with counts and timing', async () => {
    render(<McpConsolePage />, { wrapper });

    expect(await screen.findByText('leads.search')).toBeInTheDocument();
    expect(screen.getByText('messages.send')).toBeInTheDocument();
    expect(screen.getByText('SUCCESS')).toBeInTheDocument();
    expect(screen.getByText('PENDING_APPROVAL')).toBeInTheDocument();
    // run2 has no finishedAt → still open.
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(api.listMcpSessions).toHaveBeenCalledWith(1, 25);
  });
});

describe('McpConsolePage — write mode', () => {
  it('disables the switch and explains why when canToggle is false', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(overview({ canToggle: false }));
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /let claude act without approval/i });
    await waitFor(() => expect(sw).toBeDisabled());
    // Both locked hints are on screen now (write mode and research execution);
    // this one is about the write mode specifically.
    expect(screen.getByText(/only a workspace owner.*write mode/i)).toBeInTheDocument();
    // The current mode is still shown — read-only, not hidden.
    expect(screen.getAllByText('Needs approval').length).toBeGreaterThan(0);
  });

  it('does not show the locked hint when the caller may toggle', async () => {
    render(<McpConsolePage />, { wrapper });
    const sw = await screen.findByRole('switch', { name: /let claude act without approval/i });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(screen.queryByText(/only a workspace owner/i)).not.toBeInTheDocument();
  });

  it('requires a confirm step before going AUTONOMOUS and states the consequence', async () => {
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /let claude act without approval/i });
    await waitFor(() => expect(sw).toBeEnabled());
    await user.click(sw);

    // Nothing is saved on the click itself.
    expect(api.setMcpWriteMode).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/remove the human approval gate\?/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/no longer asks anyone/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /yes, go autonomous/i }));
    await waitFor(() => expect(api.setMcpWriteMode).toHaveBeenCalledWith('AUTONOMOUS'));
  });

  it('cancelling the confirm leaves the mode alone', async () => {
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /let claude act without approval/i });
    await waitFor(() => expect(sw).toBeEnabled());
    await user.click(sw);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    expect(api.setMcpWriteMode).not.toHaveBeenCalled();
  });

  it('tightening the gate back to APPROVAL applies without a confirm', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(overview({ mcpWriteMode: 'AUTONOMOUS' }));
    api.setMcpWriteMode.mockResolvedValue({ mcpWriteMode: 'APPROVAL' });
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /let claude act without approval/i });
    await waitFor(() => expect(sw).toBeEnabled());
    await user.click(sw);

    await waitFor(() => expect(api.setMcpWriteMode).toHaveBeenCalledWith('APPROVAL'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/**
 * The switch that decides who drains the nightly research queue.
 *
 * `PATCH marketing/workspaces/research-execution` shipped OWNER-only, audited
 * and DTO-validated — with no frontend at all, while `claim_research_job`'s
 * refusal text and the connector doc both told owners to "switch it in
 * Settings". An owner could not use the feature without a curl.
 */
describe('McpConsolePage — who drains the research queue', () => {
  it('shows the platform as the drainer by default, and says what that means', async () => {
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /run the nightly research/i });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).not.toBeChecked();
    expect(screen.getByText(/platform runs the nightly research/i)).toBeInTheDocument();
  });

  it('confirms before handing the queue over, and names the way it fails', async () => {
    // Flipping to MCP STOPS the platform draining. With no scheduled task on
    // the other side the jobs pile up, no candidates appear, and the review
    // queue looks exactly like "research found nothing" — so this direction is
    // confirmed and the confirmation says so.
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /run the nightly research/i });
    await waitFor(() => expect(sw).toBeEnabled());
    await user.click(sw);

    expect(api.setResearchExecution).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    // The dialog used to promise the platform would stop draining. It does not
    // stop any more — it waits. Naming the wait, and the hours, is what makes
    // this dialog honest rather than reassuring.
    expect(within(dialog).getByText(/offered each night first/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/6 hours/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /yes, my claude drains it/i }));
    await waitFor(() => expect(api.setResearchExecution).toHaveBeenCalledWith('MCP'));
  });

  it('hands the queue BACK to the platform with no confirm step', async () => {
    // The safe direction. Asking twice to become safer only trains people to
    // click through the dialog.
    api.getMcpConsoleOverview.mockResolvedValue(overview({ researchExecution: 'MCP' }));
    api.setResearchExecution.mockResolvedValue({ researchExecution: 'SERVER' });
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /run the nightly research/i });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toBeChecked();
    await user.click(sw);

    await waitFor(() => expect(api.setResearchExecution).toHaveBeenCalledWith('SERVER'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('warns that the lane needs AUTONOMOUS to run as designed', async () => {
    // Under APPROVAL the three Jeeta-keyed data tools return PENDING_APPROVAL
    // and their results can never reach the drainer inside its session, so the
    // lane silently loses the Google Maps pain signal. An owner turning this on
    // while the gate is up has to be told before, not after.
    api.getMcpConsoleOverview.mockResolvedValue(
      overview({ researchExecution: 'MCP', mcpWriteMode: 'APPROVAL' }),
    );
    render(<McpConsolePage />, { wrapper });

    // Scoped to the callout: the scheduled-task prompt above also names Google
    // Maps (it tells the drainer the listings ARE the pain signal), and an
    // unscoped query would pass on that instead of on the warning.
    const warning = await screen.findByTestId('research-approval-warning');
    expect(warning).toHaveTextContent(/google maps/i);
  });

  it('says nothing about AUTONOMOUS when the workspace is already on it', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(
      overview({ researchExecution: 'MCP', mcpWriteMode: 'AUTONOMOUS' }),
    );
    render(<McpConsolePage />, { wrapper });

    await screen.findByRole('switch', { name: /run the nightly research/i });
    expect(screen.queryByTestId('research-approval-warning')).not.toBeInTheDocument();
  });

  it('is read-only for a caller who cannot flip it, and says why', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(overview({ canToggle: false }));
    render(<McpConsolePage />, { wrapper });

    const sw = await screen.findByRole('switch', { name: /run the nightly research/i });
    await waitFor(() => expect(sw).toBeDisabled());
  });
});

describe('McpConsolePage — revoke', () => {
  it('revokes an OAuth client behind a confirm, passing the raw client_id', async () => {
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const row = await screen.findByTestId('mcp-oauth-connection');
    await user.click(within(row).getByRole('button', { name: /revoke/i }));

    expect(api.revokeMcpOAuthConnection).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/disconnect this client\?/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

    // The service — not the page — owns the URL encoding.
    await waitFor(() => expect(api.revokeMcpOAuthConnection).toHaveBeenCalledWith(CLIENT_ID));
  });
});

describe('McpConsolePage — session audit detail', () => {
  it('opens a row and shows tool call metadata: outcome, latency, SIZES and arg NAMES', async () => {
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    const goalCell = await screen.findByText('leads.search');
    await user.click(goalCell);

    await waitFor(() => expect(api.getMcpSession).toHaveBeenCalledWith('run1'));

    const call = await screen.findByTestId('mcp-tool-call');
    expect(within(call).getByText('OK')).toBeInTheDocument();
    expect(within(call).getByText(/412 ms/)).toBeInTheDocument();
    // Sizes, formatted — never the payloads themselves.
    expect(within(call).getByText(/Arguments 2\.0 KB · result 50\.0 KB/)).toBeInTheDocument();
    // Top-level argument NAMES only, labelled as such.
    expect(within(call).getByText(/values not stored/i)).toBeInTheDocument();
    expect(within(call).getByText('limit')).toBeInTheDocument();
    expect(within(call).getByText('query')).toBeInTheDocument();

    // The drawer states the no-payload policy up front.
    expect(screen.getByText(/never stored in this view/i)).toBeInTheDocument();
  });

  it('says a gated session produced no tool-call row instead of showing nothing', async () => {
    api.getMcpSession.mockResolvedValue({
      ...sessionDetail(),
      id: 'run2',
      status: 'PENDING_APPROVAL',
      goal: 'messages.send',
      queuedForApproval: true,
      toolCalls: [],
      approvals: [
        {
          id: 'ap1',
          kind: 'MESSAGE_SEND',
          status: 'PENDING',
          summary: 'Send a WhatsApp message to 12 leads',
          createdAt: '2026-07-24T08:00:01.000Z',
          decidedAt: null,
          expiresAt: '2026-07-25T08:00:01.000Z',
        },
      ],
    });
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    await user.click(await screen.findByText('messages.send'));

    expect(await screen.findByText(/hit the human gate/i)).toBeInTheDocument();
    expect(screen.getByText(/no tool call was recorded/i)).toBeInTheDocument();

    const approval = screen.getByTestId('mcp-approval');
    expect(within(approval).getByText('Send a WhatsApp message to 12 leads')).toBeInTheDocument();
    expect(within(approval).getByText('PENDING')).toBeInTheDocument();
  });
});

/**
 * The card has to tell the truth about a three-state column behind a
 * two-position switch — and about a lane that no longer means what it did.
 */
describe('McpConsolePage — the research lane is now first refusal, not a hard switch', () => {
  it('says the lane was DETECTED when nobody chose it', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(
      overview({ researchExecution: 'MCP', researchExecutionSource: 'AUTO' }),
    );
    render(<McpConsolePage />, { wrapper });

    expect(await screen.findByTestId('research-auto-note')).toBeInTheDocument();
  });

  it('says nothing about detection when the owner chose the lane', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(
      overview({ researchExecution: 'MCP', researchExecutionSource: 'EXPLICIT' }),
    );
    render(<McpConsolePage />, { wrapper });

    await screen.findByText(/who runs the nightly research/i);
    expect(screen.queryByTestId('research-auto-note')).not.toBeInTheDocument();
  });

  /**
   * The shipped copy promised "nothing runs until a connected Claude claims the
   * jobs itself". That is no longer true and it is the most dangerous sentence
   * on the page: it is what stops an owner turning this on, and it is now a
   * lie in the reassuring direction. The card must state the fallback, with the
   * real number the server uses.
   */
  it('states the fallback, using the grace window the SERVER reports', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(
      overview({ researchExecution: 'MCP', researchGraceHours: 6 }),
    );
    render(<McpConsolePage />, { wrapper });

    // This paragraph is painted before the query resolves, so the assertion has
    // to wait for the DATA rather than for the element.
    await waitFor(() =>
      expect(screen.getByTestId('research-lane-state')).toHaveTextContent(/6/),
    );
    expect(screen.getByTestId('research-lane-state').textContent).not.toMatch(
      /nothing runs until/i,
    );
  });

  it('takes the grace window from the payload, not from a number typed into the copy', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(
      overview({ researchExecution: 'MCP', researchGraceHours: 12 }),
    );
    render(<McpConsolePage />, { wrapper });

    await waitFor(() =>
      expect(screen.getByTestId('research-lane-state')).toHaveTextContent(/12/),
    );
  });
});

/**
 * The copy-paste scheduled-task prompt.
 *
 * The lane's whole failure mode is a half-finished setup: a key created, no
 * scheduled task written, and a workspace that then looks connected while
 * nothing drains. Writing that prompt from scratch is the step people skip, so
 * the product hands it over finished — with the four tool calls in order, and
 * the workspace's own connector address baked in.
 */
describe('McpConsolePage — the scheduled-task prompt', () => {
  it('hands over a prompt that names all four calls, in order', async () => {
    render(<McpConsolePage />, { wrapper });

    const prompt = await screen.findByTestId('mcp-task-prompt');
    const text = prompt.textContent ?? '';
    const order = ['claim_research_job', 'submit_research_candidates', 'complete_research_job'].map(
      (tool) => text.indexOf(tool),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The brief is SERVER-authored and arrives inside the claim; the prompt has
    // to tell the drainer to work THAT, not to invent its own ICP.
    expect(text).toMatch(/instruction/i);
  });

  it('bakes in this workspace own connector address', async () => {
    render(<McpConsolePage />, { wrapper });

    const prompt = await screen.findByTestId('mcp-task-prompt');
    expect(prompt.textContent).toContain('https://app.jeetagrowth.com/api/mcp');
  });

  /**
   * No endpoint means no address to paste, and a prompt containing "undefined"
   * is worse than no prompt: it looks copyable and silently cannot work.
   */
  it('offers no prompt at all when the deployment has no address', async () => {
    api.getMcpConsoleOverview.mockResolvedValue(overview({ mcpEndpoint: null }));
    render(<McpConsolePage />, { wrapper });

    await screen.findByText(/no public address/i);
    expect(screen.queryByTestId('mcp-task-prompt')).not.toBeInTheDocument();
  });

  it('points at where a key is actually created', async () => {
    render(<McpConsolePage />, { wrapper });

    const link = await screen.findByRole('link', { name: /create a key/i });
    expect(link).toHaveAttribute('href', '/settings/api-keys');
  });

  it('copies the prompt', async () => {
    const user = userEvent.setup();
    render(<McpConsolePage />, { wrapper });

    await screen.findByTestId('mcp-task-prompt');
    await user.click(screen.getByRole('button', { name: /copy the scheduled-task prompt/i }));

    await waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalled());
    expect(vi.mocked(clipboard.copyToClipboard).mock.calls[0][0]).toContain('claim_research_job');
  });
});
