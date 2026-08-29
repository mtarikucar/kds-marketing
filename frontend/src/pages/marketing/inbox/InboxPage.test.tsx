import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import InboxPage from './InboxPage';
import type { Lead } from '../../../features/marketing/types';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

const listConversations = vi.fn();
vi.mock('../../../features/marketing/api/conversations.service', () => ({
  listConversations: (...a: unknown[]) => listConversations(...a),
  startConversation: vi.fn(),
}));

const person = (id: string, name: string): Lead =>
  ({
    id,
    businessName: `Firma ${name}`,
    contactPerson: name,
    businessType: 'OTHER',
    source: 'OTHER',
    status: 'NEW',
    priority: 'MEDIUM',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }) as Lead;

const ALICE = person('p1', 'Ayşe');
const BORA = person('p2', 'Bora');

// The list has its own file and its own thirteen tests. Here it is reduced to
// the one thing the SURFACE is answerable for: it hands a person up.
vi.mock('./PeopleList', () => ({
  PeopleList: ({ selectedId, onSelect }: any) => (
    <div>
      <span data-testid="list-selected">selected:{selectedId ?? 'none'}</span>
      {[ALICE, BORA].map((p) => (
        <button key={p.id} onClick={() => onSelect(p)}>
          {p.contactPerson}
        </button>
      ))}
    </div>
  ),
}));

// PersonPane is REAL below — the composer it owns is what proves per-person
// state resets. Only its two heavy children are stubbed.
vi.mock('../../../features/marketing/components/LeadStream', () => ({
  default: ({ leadId }: { leadId: string }) => <div data-testid="stream">stream:{leadId}</div>,
}));
vi.mock('../leadDetail/LeadHeaderActions', () => ({ default: () => null }));

vi.mock('../ChannelsSettingsPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div>channels-embedded:{String(!!embedded)}</div>
  ),
}));
vi.mock('../settings/snippets', () => ({ default: () => <div>snippets-page</div> }));
vi.mock('../AgentStudioPage', () => ({ default: () => <div>agents-page</div> }));
vi.mock('../KnowledgeBasePage', () => ({ default: () => <div>knowledge-page</div> }));
vi.mock('../leads/LeadsPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="leads-table">leads-embedded:{String(!!embedded)}</div>
  ),
}));

const auth = vi.hoisted(() => ({ role: 'MANAGER' }));
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { accessToken: 'tok', user: { role: auth.role, id: 'u-1' } };
    return sel ? sel(state) : state;
  },
}));
vi.mock('../../../lib/env', () => ({ API_URL: 'http://test' }));

let FEATURES = new Set<string>(['conversationAi']);
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: (k?: string) => !k || FEATURES.has(k), isLoading: false }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

/** Records the URL so a test can prove a selection did NOT navigate. */
let seenPath = '';
function PathProbe() {
  const loc = useLocation();
  seenPath = `${loc.pathname}${loc.search}`;
  return null;
}

function renderAt(path = '/leads', qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <PathProbe />
        <Routes>
          <Route path="*" element={<InboxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'MANAGER';
  FEATURES = new Set(['conversationAi']);
  seenPath = '';
  // The SSE effect uses fetch(); reject it by default so nothing connects.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  get.mockResolvedValue({ data: [] });
  post.mockResolvedValue({ data: {} });
  listConversations.mockResolvedValue([]);
});

describe('The person surface — three columns, one object', () => {
  it('renders all three columns', async () => {
    renderAt();

    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
    expect(screen.getByTestId('surface-list')).toBeInTheDocument();
    expect(screen.getByTestId('surface-pane')).toBeInTheDocument();
    expect(screen.getByTestId('surface-card')).toBeInTheDocument();
  });

  it('shows one page header, not one per merged page', async () => {
    renderAt();
    await screen.findByTestId('person-surface');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('opens the selected person in the other two columns, and does not navigate', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    const before = seenPath;

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));

    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p1');
    expect(within(screen.getByTestId('surface-card')).getByTestId('record-card')).toHaveTextContent(
      'Ayşe',
    );
    expect(screen.getByTestId('list-selected')).toHaveTextContent('selected:p1');
    // The whole correction, asserted at the surface: a selection is not a URL.
    expect(seenPath).toBe(before);
  });

  it('says nobody is selected rather than showing an empty conversation', async () => {
    renderAt();
    expect(await screen.findByTestId('person-pane-idle')).toBeInTheDocument();
  });
});

/**
 * The bug this branch has already shipped once, in a different component: a
 * header kept lead A's phone number and dialled it under lead B's id. Every
 * piece of the middle column's state is per-person, and `key` is the ONE
 * mechanism that resets it. A test, because "by construction" is exactly the
 * kind of thing that stops being true later.
 */
describe('The person surface — per-person state does not follow the rep', () => {
  beforeEach(() => {
    listConversations.mockResolvedValue([
      { id: 'c1', status: 'OPEN', aiPaused: false, unreadCount: 0, channel: { type: 'SMS' } },
    ]);
  });

  it('drops a half-typed reply when the selection moves to someone else', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    const box = await screen.findByLabelText('Yanıt yaz');
    await user.type(box, 'Ayşe’ye özel');
    expect((box as HTMLInputElement).value).toBe('Ayşe’ye özel');

    await user.click(screen.getByRole('button', { name: 'Bora' }));

    // Anchor on the NEW person's pane before reading the box, so an empty
    // value cannot be an un-rendered one.
    await waitFor(() => expect(screen.getByTestId('stream')).toHaveTextContent('stream:p2'));
    expect((screen.getByLabelText('Yanıt yaz') as HTMLInputElement).value).toBe('');
  });
});

/**
 * The live stream. Its old wiring refreshed the conversation list and the open
 * THREAD; the middle column is no longer a thread, so an inbound message landed
 * in the database and nothing moved on screen until a reload.
 */
describe('The person surface — a live message reaches the open person', () => {
  /**
   * An SSE endpoint that delivers ONE frame per CONNECTION.
   *
   * Per connection, not once in total: the surface reconnects when the selected
   * person changes, so a fixture that fires only on the first connection
   * delivers its frame while nobody is selected — a green test of nothing.
   */
  const oneFramePerConnection = (payload: unknown) => {
    const encoder = new TextEncoder();
    return vi.fn().mockImplementation(async () => {
      let sent = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return {
                done: false,
                value: encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
              };
            },
          }),
        },
      };
    });
  };

  it('refreshes the open person’s stream, the people list and the threads', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', oneFramePerConnection({ kind: 'message', conversationId: 'c9' }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p1'] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'conversations'] });
  });

  it('ignores a heartbeat — it is a keep-alive, not news', async () => {
    vi.stubGlobal('fetch', oneFramePerConnection({ kind: 'heartbeat' }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    // Positive anchor: the surface is up, so the stream effect has run.
    await screen.findByTestId('person-surface');
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['marketing', 'conversations'] });
  });
});

/**
 * `/leads` carries no entitlement; `GET /conversations` and the SSE endpoint
 * both require `conversationAi`. A workspace without it gets the whole surface —
 * what degrades is the message half, with a reason.
 */
describe('The person surface — a workspace without the conversation add-on', () => {
  beforeEach(() => {
    FEATURES = new Set();
  });

  it('never opens a stream it is not allowed to have', async () => {
    renderAt();
    await screen.findByTestId('person-surface');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('still gives them all three columns', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));

    expect(await screen.findByTestId('stream')).toBeInTheDocument();
    expect(within(screen.getByTestId('surface-card')).getByTestId('record-card')).toBeInTheDocument();
    // The message half says which plan line is missing rather than going blank.
    expect(screen.getByTestId('person-pane-gated')).toBeInTheDocument();
  });
});

/**
 * The four conversation-domain config surfaces. They were behind one gear
 * before this rewrite and they still are — `?tab=` deep links are pasted into
 * onboarding docs and Slack.
 */
describe('The person surface — config surfaces behind the gear (?tab=)', () => {
  it('opens one from the gear menu', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');

    await user.click(await screen.findByRole('button', { name: /inbox settings/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'AI Agents' }));

    expect(await screen.findByText('agents-page')).toBeInTheDocument();
  });

  it('honours a ?tab= deep link, embedded, with a way back', async () => {
    renderAt('/inbox?tab=channels');

    expect(await screen.findByText('channels-embedded:true')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to inbox/i })).toBeInTheDocument();
    expect(screen.queryByTestId('person-surface')).not.toBeInTheDocument();
  });

  it('falls back to the surface on an unknown ?tab= value', async () => {
    renderAt('/inbox?tab=not-a-real-tab');
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
  });

  it('hides the gear from a rep and lands their deep link on the surface', async () => {
    auth.role = 'REP';
    renderAt('/inbox?tab=channels');

    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /inbox settings/i })).not.toBeInTheDocument();
    expect(screen.queryByText('channels-embedded:true')).not.toBeInTheDocument();
  });
});

/**
 * The leads TABLE, as a second view of the same people rather than a second
 * object. It is where bulk assign, bulk delete, bulk enrol and CSV export live,
 * and they exist nowhere else in the product — see InboxPage's docstring, where
 * this deviation from "one list, no tabs" is recorded.
 */
describe('The person surface — the table is a view, not the default', () => {
  it('opens the three columns, not the table, on both routes', async () => {
    renderAt('/leads');
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('leads-table')).not.toBeInTheDocument();
  });

  it('reaches the table on request, embedded so the header stays single', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    await screen.findByTestId('person-surface');

    await user.click(screen.getByRole('button', { name: /Tablo/ }));

    expect(await screen.findByTestId('leads-table')).toHaveTextContent('leads-embedded:true');
    expect(screen.queryByTestId('person-surface')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('honours ?view=table as a deep link, and comes back', async () => {
    const user = userEvent.setup();
    renderAt('/leads?view=table');

    expect(await screen.findByTestId('leads-table')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Liste/ }));
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
  });
});
