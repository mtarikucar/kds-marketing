import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
    // `GET /leads` includes the relation, so an unowned lead arrives as an
    // explicit NULL. The distinction is load-bearing on the record card: null
    // means nobody owns them, undefined means nobody has said.
    assignedTo: null,
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

/**
 * The three pages the left column can arrange the same people with. Each has
 * its own file and its own tests for what it DOES; here they are reduced to the
 * two things the SURFACE is answerable for — that they arrive `embedded`, and
 * that they can hand a person up.
 *
 * `BOARD_BROKEN` lets one test make a view throw on render, which is what a
 * failed chunk load looks like to React.
 */
const BOARD_BROKEN = vi.hoisted(() => ({ value: false }));
const viewDouble = (testid: string) =>
  function View({ embedded, onSelectPerson, selectedLeadId }: any) {
    if (testid === 'view-board' && BOARD_BROKEN.value) throw new Error('chunk failed');
    return (
      <div data-testid={testid}>
        embedded:{String(!!embedded)} open:{selectedLeadId ?? 'none'}
        <button onClick={() => onSelectPerson?.({ id: 'p2', contactPerson: 'Bora' })}>
          {testid}-pick-Bora
        </button>
      </div>
    );
  };

vi.mock('../opportunities/OpportunitiesPage', () => ({ default: viewDouble('view-board') }));
vi.mock('../calendar/CalendarPage', () => ({ default: viewDouble('view-calendar') }));
vi.mock('../tasks/TasksPage', () => ({ default: viewDouble('view-tasks') }));

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
  BOARD_BROKEN.value = false;
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
   * An SSE endpoint that STAYS OPEN and delivers what a test pushes into it.
   *
   * It used to be "one frame per CONNECTION", with a comment explaining that
   * the surface reconnects when the selected person changes. That comment
   * documented a bug and then relied on it: `ConversationStreamService` is a
   * plain per-workspace RxJS Subject with no replay, so every frame the server
   * pushed during a teardown/reconnect window was gone for good, and a rep
   * clicking through their queue silently missed messages. The surface now
   * holds one connection for its lifetime, so the fixture has to be able to
   * deliver a frame at a moment the test chooses rather than at a reconnect.
   */
  const openStream = () => {
    const encoder = new TextEncoder();
    const queued: Uint8Array[] = [];
    let waiting: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;

    const read = () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        const next = queued.shift();
        if (next) resolve({ done: false, value: next });
        else waiting = resolve;
      });

    const push = async (payload: unknown) => {
      const value = encoder.encode(`data: ${JSON.stringify(payload)}

`);
      await act(async () => {
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ done: false, value });
        } else {
          queued.push(value);
        }
        // Let the reader loop turn and the invalidations land.
        await Promise.resolve();
      });
    };

    const fetchMock = vi
      .fn()
      .mockImplementation(async () => ({ ok: true, body: { getReader: () => ({ read }) } }));

    return { fetchMock, push };
  };

  it('refreshes the open person’s stream, the people list and the threads', async () => {
    const user = userEvent.setup();
    const { fetchMock, push } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await push({ kind: 'message', conversationId: 'c9' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p1'] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'conversations'] });
  });

  /**
   * The reason the fixture above had to change, asserted directly.
   *
   * The effect used to list the whole selected ROW in its dependency array, so
   * every click aborted the fetch and opened a new connection. The stream has
   * no replay: anything the server pushed in that window was lost, and the
   * window is exactly when a rep is moving through their queue.
   */
  it('holds ONE connection across selections rather than reconnecting per click', async () => {
    const user = userEvent.setup();
    const { fetchMock } = openStream();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/leads');

    await screen.findByTestId('person-surface');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Ayşe' }));
    await waitFor(() =>
      expect(screen.getByTestId('list-selected')).toHaveTextContent('selected:p1'),
    );
    await user.click(screen.getByRole('button', { name: 'Bora' }));
    await waitFor(() =>
      expect(screen.getByTestId('list-selected')).toHaveTextContent('selected:p2'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * And the half that a `useRef` could quietly break: reading the id out of a
   * ref instead of the closure is only correct if the ref is actually current
   * when a frame lands. A frame pushed AFTER a second selection has to refresh
   * the second person, not the first.
   */
  it('refreshes whoever is selected NOW, on a connection that was opened before them', async () => {
    const user = userEvent.setup();
    const { fetchMock, push } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    await user.click(screen.getByRole('button', { name: 'Bora' }));
    await waitFor(() =>
      expect(screen.getByTestId('list-selected')).toHaveTextContent('selected:p2'),
    );
    invalidate.mockClear();

    await push({ kind: 'message', conversationId: 'c9' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p2'] }),
    );
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p1'] });
  });

  /**
   * `leadId` on the frame — the whole reason it was added to
   * `ConversationStreamEvent`.
   *
   * Before it, a frame said only which CONVERSATION it happened on, so this
   * surface could not tell an event about the open person from an event about
   * anyone else and refreshed the open person on every one. That key now
   * carries the record card's five sections behind it (activities, offers,
   * tasks), and stage 2 hangs more observers off it, so every unrelated SMS in
   * the workspace was buying a fat refetch for a screen that had not changed.
   */
  it('leaves the open person alone when the frame names somebody else', async () => {
    const user = userEvent.setup();
    const { fetchMock, push } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    invalidate.mockClear();

    await push({ kind: 'message', conversationId: 'c9', leadId: 'p2' });

    // Positive anchor first: the frame WAS handled. Asserting only the absence
    // would pass just as well against a frame that never arrived.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'conversations'] }),
    );
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p1'] });
  });

  it('refreshes the open person when the frame names them', async () => {
    const user = userEvent.setup();
    const { fetchMock, push } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await push({ kind: 'message', conversationId: 'c9', leadId: 'p1' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p1'] }),
    );
  });

  /**
   * The fallback, and it is the direction this field is allowed to fail in. A
   * publisher that could not cheaply resolve the lead (the delivery-receipt
   * path, when its lookup throws) sends the frame without one, and an
   * un-upgraded server sends every frame without one. Both must degrade to
   * "refresh everything", never to "refresh nothing": a dropped inbound is a
   * rep replying to a customer whose last line they cannot see.
   */
  it('falls back to refreshing the open person when the frame names nobody', async () => {
    const user = userEvent.setup();
    const { fetchMock, push } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await push({ kind: 'status', conversationId: 'c9' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'p1'] }),
    );
  });

  it('ignores a heartbeat — it is a keep-alive, not news', async () => {
    const { fetchMock, push } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderAt('/leads', qc);

    // Positive anchor: the surface is up, so the stream effect has run.
    await screen.findByTestId('person-surface');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await push({ kind: 'heartbeat' });

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
 * The leads TABLE. It is where bulk assign, bulk delete, bulk enrol and CSV
 * export live, and they exist nowhere else in the product — see InboxPage's
 * docstring, where this deviation from "one list, no tabs" is recorded.
 *
 * Its ENTRY POINT is behind the gear. Rendered as a full-weight outline button
 * in the header, shown to reps, at the same visual weight as the primary
 * chrome, it read as a peer VIEW — which is the second list the owner objected
 * to, wearing a different word. Its whole justification is manager tooling
 * (`LeadsPage` gates the checkbox column and the bulk toolbar on `isManager`),
 * so it sits where the other manager-only surfaces already sit.
 */
describe('The person surface — the table is behind the gear, not beside the title', () => {
  it('opens the three columns, not the table, on both routes', async () => {
    renderAt('/leads');
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('leads-table')).not.toBeInTheDocument();
  });

  it('is not page chrome — nothing in the header competes with the surface', async () => {
    renderAt('/leads');
    await screen.findByTestId('person-surface');

    // The gear is the only action. A button labelled Tablo standing beside the
    // title is the framing this moved away from.
    expect(screen.queryByRole('button', { name: /Tablo/ })).not.toBeInTheDocument();
  });

  it('reaches the table from the gear, embedded so the header stays single', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    await screen.findByTestId('person-surface');

    await user.click(screen.getByRole('button', { name: /inbox settings/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Tablo/ }));

    expect(await screen.findByTestId('leads-table')).toHaveTextContent('leads-embedded:true');
    expect(screen.queryByTestId('person-surface')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('honours ?view=table as a deep link, and the gear brings you back', async () => {
    const user = userEvent.setup();
    renderAt('/leads?view=table');

    expect(await screen.findByTestId('leads-table')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /inbox settings/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Liste/ }));
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
  });

  /**
   * A rep is offered nothing — but their deep link still works, and that is
   * deliberate rather than an oversight. Unlike `?tab=`, which opens surfaces
   * that CONFIGURE the workspace and whose render is therefore guarded, the
   * table is the same people a rep already sees in the left column; the tools
   * that are manager-only are gated inside `LeadsPage` itself. Bouncing a
   * pasted link would take away a view without taking away a permission.
   */
  it('offers a rep no way in, and still opens their pasted link', async () => {
    auth.role = 'REP';
    renderAt('/leads');
    await screen.findByTestId('person-surface');
    expect(screen.queryByRole('button', { name: /inbox settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tablo/ })).not.toBeInTheDocument();

    cleanup();
    renderAt('/leads?view=table');
    expect(await screen.findByTestId('leads-table')).toBeInTheDocument();
  });

  /**
   * The gear exists for the table alone when the four config surfaces are not
   * available. `?tab=` is gated on `conversationAi` — every one of those pages
   * configures that domain — and the table is not: `/leads` carries no
   * entitlement at all. Folding the table into the same condition would have
   * deleted a manager's bulk assign for a workspace that never bought the
   * conversation add-on.
   */
  it('still gives a manager the table when the conversation add-on is missing', async () => {
    const user = userEvent.setup();
    FEATURES = new Set();
    renderAt('/leads');
    await screen.findByTestId('person-surface');

    await user.click(screen.getByRole('button', { name: /inbox settings/i }));
    expect(screen.queryByRole('menuitem', { name: 'AI Agents' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /Tablo/ }));

    expect(await screen.findByTestId('leads-table')).toBeInTheDocument();
  });
});


/**
 * Stage 2 of the one-screen brief (2026-09-01 design, §"Karar 1"): the LEFT
 * column switches between four arrangements of the same people — Liste · Hat ·
 * Takvim · Görevler — while the middle column (their stream) and the right
 * column (their record card) stay exactly as they are.
 *
 * The owner's sentence for why: "hattan birine tıklayıp aynı ekranda
 * yazışmasını okursun; seçili kişi görünüm değişince korunur." Both halves are
 * asserted below, and the second one is the whole reason the view lives beside
 * the selection rather than inside it.
 */
describe('The person surface — the left column switches views', () => {
  const tab = (name: RegExp) => screen.getByRole('tab', { name });

  it('offers all four arrangements and starts on the list', async () => {
    renderAt('/leads');

    await screen.findByTestId('surface-list');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(tab(/^Liste$/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('list-selected')).toBeInTheDocument();
  });

  it('opens the pipeline in the left column, embedded, without touching the other two', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    await screen.findByTestId('surface-list');

    await user.click(tab(/^Hat$/));

    expect(await screen.findByTestId('view-board')).toHaveTextContent('embedded:true');
    // The other two columns are untouched — that is the point of the surface.
    expect(screen.getByTestId('surface-pane')).toBeInTheDocument();
    expect(screen.getByTestId('surface-card')).toBeInTheDocument();
    // …and the list it replaced is gone, not merely hidden behind it.
    expect(screen.queryByTestId('list-selected')).not.toBeInTheDocument();
  });

  it.each([
    ['board', 'view-board'],
    ['calendar', 'view-calendar'],
    ['tasks', 'view-tasks'],
  ])('honours ?left=%s as a deep link', async (param, testid) => {
    renderAt(`/leads?left=${param}`);
    expect(await screen.findByTestId(testid)).toBeInTheDocument();
  });

  it('falls back to the list on an unknown ?left= value', async () => {
    renderAt('/leads?left=not-a-view');
    expect(await screen.findByTestId('list-selected')).toBeInTheDocument();
  });

  it('puts the view in the URL, so a colleague can be sent one', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    await screen.findByTestId('surface-list');

    await user.click(tab(/^Görevler$/));

    await screen.findByTestId('view-tasks');
    expect(seenPath).toContain('left=tasks');
  });

  /**
   * The constraint the design states outright. A rep triaging a person switches
   * to the pipeline to see where their deal stands and expects to still be
   * looking at that person — losing the selection would make the switcher a
   * navigation, which is the thing this whole surface stopped doing.
   */
  it('keeps the selected person across a view switch', async () => {
    const user = userEvent.setup();
    renderAt('/leads');

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p1');

    await user.click(tab(/^Hat$/));

    // The board is up AND it knows who is open…
    expect(await screen.findByTestId('view-board')).toHaveTextContent('open:p1');
    // …and the other two columns never let go.
    expect(screen.getByTestId('stream')).toHaveTextContent('stream:p1');
    expect(within(screen.getByTestId('surface-card')).getByTestId('record-card')).toBeInTheDocument();
  });

  it('keeps them across a switch back, too', async () => {
    const user = userEvent.setup();
    renderAt('/leads');

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));
    await user.click(tab(/^Takvim$/));
    await screen.findByTestId('view-calendar');
    await user.click(tab(/^Liste$/));

    expect(await screen.findByTestId('list-selected')).toHaveTextContent('selected:p1');
    expect(screen.getByTestId('stream')).toHaveTextContent('stream:p1');
  });

  /**
   * "Hattan birine tıklayıp aynı ekranda yazışmasını okursun." A click in any of
   * the three new views SELECTS — the same contract the list row has had since
   * the surface replaced its two tabs — and it does not navigate.
   */
  it('opens a person picked from the board in the other two columns, without navigating', async () => {
    const user = userEvent.setup();
    renderAt('/leads?left=board');
    await screen.findByTestId('view-board');
    const before = seenPath;

    await user.click(screen.getByRole('button', { name: 'view-board-pick-Bora' }));

    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p2');
    expect(within(screen.getByTestId('surface-card')).getByTestId('record-card')).toBeInTheDocument();
    expect(seenPath).toBe(before);
  });

  /**
   * A view that cannot be RENDERED — the shape a failed lazy chunk takes — must
   * say so, by name, in its own column. The layout's ErrorBoundary is keyed on
   * the route, so without a boundary here one broken view would take the stream
   * and the record card down with it and leave the whole surface reading
   * "Something went wrong".
   */
  it('names a view that could not be opened, and keeps the other two columns', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    await screen.findByTestId('surface-list');
    BOARD_BROKEN.value = true;

    await user.click(tab(/^Hat$/));

    expect(await screen.findByTestId('view-failed')).toHaveTextContent('Hat');
    expect(screen.getByTestId('surface-pane')).toBeInTheDocument();
    expect(screen.getByTestId('surface-card')).toBeInTheDocument();
  });

  /**
   * The three new views know a person's id and their name and very little else
   * — a board card carries no `smsOptOut`, a task row carries only a business
   * name. The surface therefore resolves the person against
   * `['marketing','lead', id]`, the SAME key the record card is already reading
   * for its Görevler and Teklifler sections, so this costs no extra request and
   * adds no second answer to "who is this".
   *
   * Without it the middle column silently loses "Ara" and "Mesaj" for anyone
   * picked outside the list: `LeadHeaderActions` renders nothing when the lead
   * has no phone, and a missing button is the quietest possible regression.
   */
  it('fills in the person a view could only half-describe', async () => {
    const user = userEvent.setup();
    get.mockImplementation((url: string) => {
      if (url === '/leads/p2')
        return Promise.resolve({
          data: { id: 'p2', contactPerson: 'Bora', businessName: 'Bora AŞ', city: 'İzmir' },
        });
      return Promise.resolve({ data: [] });
    });
    renderAt('/leads?left=board');
    await screen.findByTestId('view-board');

    await user.click(screen.getByRole('button', { name: 'view-board-pick-Bora' }));

    // The card shows a field the board never had.
    expect(await screen.findByText('İzmir')).toBeInTheDocument();
  });

  /**
   * "Sahibi: Atanmamış" is an ANSWER — it is what the Atanmamış queue one
   * column over is about — so it may only be given when the record actually
   * says so. A person handed over by a view that does not carry the field, or
   * one whose record could not be read, must leave the row out rather than
   * report them as nobody's.
   */
  it('does not call a person unowned merely because it has not read their record', async () => {
    const user = userEvent.setup();
    // 404 rather than a 500: `useLeadRecord` refuses to retry a 404, so the
    // assertion below settles instead of racing three backoff attempts.
    get.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('gone'), { response: { status: 404 } })),
    );
    renderAt('/leads?left=board');
    await screen.findByTestId('view-board');

    await user.click(screen.getByRole('button', { name: 'view-board-pick-Bora' }));

    // Positive anchor: the card IS up for this person.
    expect(await screen.findByTestId('record-card')).toBeInTheDocument();
    expect(screen.queryByTestId('record-owner')).not.toBeInTheDocument();
  });

  it('still says Atanmamış when the record actually says nobody owns them', async () => {
    const user = userEvent.setup();
    renderAt('/leads');

    await user.click(await screen.findByRole('button', { name: 'Ayşe' }));

    expect(await screen.findByTestId('record-owner')).toHaveTextContent('Atanmamış');
  });
});
