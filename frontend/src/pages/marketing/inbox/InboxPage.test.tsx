import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import InboxPage from './InboxPage';

const get = vi.fn();
const post = vi.fn().mockResolvedValue({ data: {} });

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
// Role is switchable per test — the config tabs are manager-only.
const auth = vi.hoisted(() => ({ role: 'MANAGER' }));
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ accessToken: 'tok', user: { role: auth.role } }),
}));
vi.mock('../../../lib/env', () => ({ API_URL: 'http://test' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ?? k,
    i18n: { language: 'en' },
  }),
}));

// Isolate InboxPage's own state logic from the heavy child trees: the
// ConversationList exposes onSelect, the ThreadPane exposes the controlled draft.
vi.mock('./ConversationList', () => ({
  ConversationList: ({ conversations, onSelect }: any) => (
    <div>
      {(conversations ?? []).map((c: any) => (
        <button key={c.id} onClick={() => onSelect(c.id)}>
          {c.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./ThreadPane', () => ({
  ThreadPane: ({ draft, onDraftChange }: any) => (
    <input aria-label="composer" value={draft} onChange={(e: any) => onDraftChange(e.target.value)} />
  ),
}));
vi.mock('./LeadContextPane', () => ({ LeadContextPane: () => null }));

// Stub the lazy-loaded config tab pages — only the tab shell is under test here.
vi.mock('../ChannelsSettingsPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div>channels-embedded:{String(embedded)}</div>,
}));
vi.mock('../settings/snippets', () => ({ default: () => <div>snippets-page</div> }));
vi.mock('../AgentStudioPage', () => ({ default: () => <div>agents-page</div> }));
vi.mock('../KnowledgeBasePage', () => ({ default: () => <div>knowledge-page</div> }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** Render at a specific URL — the top tabs are `?tab=`-synced deep links. */
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setupApi() {
  // The live SSE stream uses fetch(); reject it so the component renders without
  // a real connection (the effect just schedules a reconnect, harmless here).
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  auth.role = 'MANAGER';
  get.mockReset();
  post.mockClear();
  get.mockImplementation((url: string) =>
    url === '/conversations'
      ? Promise.resolve({
          data: [
            { id: 'cA', status: 'OPEN', aiPaused: false, unreadCount: 0 },
            { id: 'cB', status: 'OPEN', aiPaused: false, unreadCount: 0 },
          ],
        })
      : Promise.resolve({
          data: { conversation: { id: 'x', aiPaused: false }, lead: null, messages: [], channel: null },
        }),
  );
}

describe('InboxPage — composer draft isolation', () => {
  beforeEach(setupApi);

  it('clears the reply draft when switching conversations (no cross-customer leak)', async () => {
    render(<InboxPage />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: 'cA' }));
    const composer = screen.getByLabelText('composer') as HTMLInputElement;
    await userEvent.type(composer, 'private note for A');
    expect(composer.value).toBe('private note for A');

    // Switching to another customer's thread must NOT carry the half-typed reply.
    await userEvent.click(screen.getByRole('button', { name: 'cB' }));
    expect((screen.getByLabelText('composer') as HTMLInputElement).value).toBe('');
  });

  it('marks a thread read AND refreshes the list so the unread badge clears now', async () => {
    render(<InboxPage />, { wrapper });
    await screen.findByRole('button', { name: 'cA' });
    const listCalls = () => get.mock.calls.filter((c) => c[0] === '/conversations').length;
    const before = listCalls();

    await userEvent.click(screen.getByRole('button', { name: 'cA' }));

    // Opening a thread marks it read server-side…
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/cA/read'));
    // …and re-fetches the list, so the badge updates without waiting for the poll.
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });
});

// 2026-07 trim: the config surfaces moved from an always-visible tab bar into
// ONE gear "Inbox settings" menu — the daily messaging page shows no config
// chrome. ?tab= deep links keep resolving unchanged.
describe('InboxPage — config surfaces behind the gear menu (?tab=)', () => {
  beforeEach(setupApi);

  it('shows the plain inbox with a single Inbox settings gear for a manager (no tab bar)', async () => {
    renderAt('/inbox');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /inbox settings/i })).toBeInTheDocument();
    // The real inbox body (mocked ConversationList) is what's mounted.
    expect(await screen.findByRole('button', { name: 'cA' })).toBeInTheDocument();
  });

  it('opens a config surface from the gear menu', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');
    await user.click(screen.getByRole('button', { name: /inbox settings/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'AI Agents' }));
    expect(await screen.findByText('agents-page')).toBeInTheDocument();
  });

  it('honors the ?tab= deep link and lazy-mounts the embedded page with a back affordance', async () => {
    renderAt('/inbox?tab=agents');
    expect(await screen.findByText('agents-page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to inbox/i })).toBeInTheDocument();
  });

  it('passes embedded to the hosted config page (no double header)', async () => {
    renderAt('/inbox?tab=channels');
    expect(await screen.findByText('channels-embedded:true')).toBeInTheDocument();
  });

  it('falls back to the inbox on an unknown ?tab= value', async () => {
    renderAt('/inbox?tab=nope');
    expect(await screen.findByRole('button', { name: 'cA' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to inbox/i })).not.toBeInTheDocument();
  });

  it('hides the gear from non-managers and forces deep links back to the inbox', async () => {
    auth.role = 'REP';
    renderAt('/inbox?tab=channels');
    expect(screen.queryByRole('button', { name: /inbox settings/i })).not.toBeInTheDocument();
    // …and the manager-only deep link lands on the inbox body, not the config page.
    expect(await screen.findByRole('button', { name: 'cA' })).toBeInTheDocument();
    expect(screen.queryByText('channels-embedded:true')).not.toBeInTheDocument();
  });
});
