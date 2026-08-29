import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonPane } from './PersonPane';
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

// The stream is its own component with its own tests and its own endpoint; all
// this pane owes it is a lead id and a place to scroll.
vi.mock('../../../features/marketing/components/LeadStream', () => ({
  default: ({ leadId }: { leadId: string }) => <div data-testid="stream">stream:{leadId}</div>,
}));

// The start-conversation dialog is LeadHeaderActions' job — reused, not
// rebuilt. Stubbed to the one fact this file asserts: it was offered, for whom.
vi.mock('../leadDetail/LeadHeaderActions', () => ({
  default: ({ lead }: { lead: { id: string } }) => (
    <div data-testid="lead-actions">actions:{lead.id}</div>
  ),
}));

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

const person = (over: Partial<Lead> = {}): Lead =>
  ({
    id: 'p1',
    businessName: 'Acme',
    contactPerson: 'Ayşe Yılmaz',
    businessType: 'OTHER',
    source: 'OTHER',
    status: 'NEW',
    priority: 'MEDIUM',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as Lead;

const thread = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  status: 'OPEN',
  aiPaused: false,
  unreadCount: 0,
  lastMessageAt: '2026-08-20T10:00:00Z',
  channel: { type: 'SMS' },
  ...over,
});

function renderPane(props: Partial<React.ComponentProps<typeof PersonPane>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PersonPane person={person()} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  FEATURES = new Set(['conversationAi']);
  get.mockResolvedValue({ data: [] });
  post.mockResolvedValue({ data: {} });
  listConversations.mockResolvedValue([thread()]);
});

describe('PersonPane — the middle column is one person’s whole history', () => {
  it('asks for nobody until somebody is selected', async () => {
    renderPane({ person: null });

    expect(await screen.findByTestId('person-pane-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('stream')).not.toBeInTheDocument();
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('shows the selected person’s stream, not a conversation’s messages', async () => {
    renderPane();
    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p1');
  });

  it('owns the scroll, so the stream can stay a plain list', async () => {
    renderPane();
    await screen.findByTestId('stream');
    expect(screen.getByTestId('person-pane-scroll').className).toContain('overflow-y-auto');
  });
});

describe('PersonPane — a person with a conversation', () => {
  it('replies into that person’s thread through the one existing send path', async () => {
    const user = userEvent.setup();
    renderPane();

    const box = await screen.findByLabelText('Yanıt yaz');
    await user.type(box, 'Merhaba');
    await user.click(screen.getByRole('button', { name: 'Gönder' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/conversations/c1/reply', { text: 'Merhaba' }),
    );
  });

  it('will not send an empty draft', async () => {
    renderPane();
    await screen.findByLabelText('Yanıt yaz');
    expect(screen.getByRole('button', { name: 'Gönder' })).toBeDisabled();
  });

  it('lets a human take the thread off the AI', async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(await screen.findByRole('button', { name: 'Yapay zekayı durdur' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/conversations/c1/ai-pause', { paused: true }),
    );
  });

  // Two threads on two channels is the case the person-first list creates:
  // picking the PERSON no longer picks the channel, so replying has to say
  // which one it is replying on — or a rep answers an email over SMS.
  it('names the channel it will reply on, and lets it be changed', async () => {
    const user = userEvent.setup();
    listConversations.mockResolvedValue([
      thread({ id: 'c-sms', channel: { type: 'SMS' }, lastMessageAt: '2026-08-20T10:00:00Z' }),
      thread({ id: 'c-mail', channel: { type: 'EMAIL' }, lastMessageAt: '2026-08-19T10:00:00Z' }),
    ]);

    renderPane();

    // The newest thread is the one in hand.
    const picker = await screen.findByRole('group', { name: 'Konuşma' });
    expect(within(picker).getByRole('button', { name: /SMS/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(picker).getByRole('button', { name: /EMAIL/ }));
    await user.type(screen.getByLabelText('Yanıt yaz'), 'ok');
    await user.click(screen.getByRole('button', { name: 'Gönder' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/conversations/c-mail/reply', { text: 'ok' }),
    );
  });
});

describe('PersonPane — a person nobody has ever written to', () => {
  it('offers to start a conversation instead of a dead composer', async () => {
    listConversations.mockResolvedValue([]);

    renderPane();

    expect(await screen.findByTestId('person-pane-start')).toHaveTextContent(
      'Bu kişiyle henüz konuşulmadı',
    );
    // The offer IS the existing dialog, reused — not a second one built here.
    expect(screen.getByTestId('lead-actions')).toHaveTextContent('actions:p1');
    expect(screen.queryByLabelText('Yanıt yaz')).not.toBeInTheDocument();
  });

  it('still shows their stream — activities are not messages', async () => {
    listConversations.mockResolvedValue([]);

    renderPane();
    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p1');
  });
});

/**
 * `/leads` carries no feature gate; `GET /conversations` requires
 * `conversationAi`. A workspace without it must still get the person and their
 * activities — what degrades is the MESSAGE half, and it degrades with a reason
 * on screen rather than into a dead box or a 403 on load.
 */
describe('PersonPane — a workspace without the conversation add-on', () => {
  beforeEach(() => {
    FEATURES = new Set();
  });

  it('never asks for conversations it may not have', async () => {
    renderPane();
    // Positive anchor first: the pane has settled, so "no call" is a decision
    // rather than a race.
    await screen.findByTestId('stream');
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('says why there is no composer instead of showing an empty one', async () => {
    renderPane();

    expect(await screen.findByTestId('person-pane-gated')).toHaveTextContent(
      'Mesajlaşma paketinde yok',
    );
    expect(screen.queryByLabelText('Yanıt yaz')).not.toBeInTheDocument();
  });

  it('keeps the stream — the column is not dead, only the messages are missing', async () => {
    renderPane();
    expect(await screen.findByTestId('stream')).toBeInTheDocument();
  });
});

/**
 * The three columns fail independently. A thread lookup that 500s must not
 * blank the person's history, and it must not be mistaken for "this person has
 * never been written to" — that mistake opens a start-conversation dialog on
 * top of a thread that already exists.
 */
describe('PersonPane — the conversation half can fail on its own', () => {
  beforeEach(() => {
    listConversations.mockRejectedValue(new Error('boom'));
  });

  it('leaves the stream standing', async () => {
    renderPane();
    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p1');
  });

  it('names the failure rather than claiming there is no conversation', async () => {
    renderPane();

    const failure = await screen.findByTestId('person-pane-threads-failed');
    expect(failure).toHaveTextContent('Konuşmalar yüklenemedi');
    // Not the silent-person branch: telling someone "nobody has written to
    // them" because a query threw is the same lie the empty state exists to
    // prevent, one column over.
    expect(screen.queryByTestId('person-pane-start')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Yanıt yaz')).not.toBeInTheDocument();
  });
});

/**
 * The internal notes panel, held to the rule the rest of this branch keeps: a
 * query that FAILED is not a query that came back empty.
 *
 * Under react-query v5 an errored query has `isLoading === false` and `data ===
 * undefined`, so a `GET /conversations/:id/notes` that 500s used to render
 * "Henüz iç not yok. Bunları yalnızca ekibin görür." — a confident claim that
 * the team wrote nothing, in the one panel whose whole content is what a
 * teammate wrote down before handing the customer over. A rep reads that and
 * starts the conversation from scratch in front of the customer.
 */
describe('PersonPane — a note nobody could fetch is not a note nobody wrote', () => {
  const openNotes = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /İç notlar/ }));
  };

  beforeEach(() => {
    get.mockImplementation((url: string) =>
      String(url).includes('/notes')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ data: [] }),
    );
  });

  it('says the notes could not be read instead of claiming there are none', async () => {
    const user = userEvent.setup();
    renderPane();
    await openNotes(user);

    expect(await screen.findByTestId('person-pane-notes-failed')).toHaveTextContent(
      'İç notlar yüklenemedi',
    );
    expect(screen.queryByText(/Henüz iç not yok/)).not.toBeInTheDocument();
  });

  it('offers a retry, because the panel is the handover and a reload is the whole page', async () => {
    const user = userEvent.setup();
    renderPane();
    await openNotes(user);
    await screen.findByTestId('person-pane-notes-failed');

    const calls = () => get.mock.calls.filter(([u]) => String(u).includes('/notes')).length;
    const before = calls();
    await user.click(screen.getByRole('button', { name: 'Yeniden dene' }));

    await waitFor(() => expect(calls()).toBeGreaterThan(before));
  });

  it('still says "no notes yet" when the fetch actually succeeded and was empty', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [] });
    renderPane();
    await openNotes(user);

    expect(await screen.findByText(/Henüz iç not yok/)).toBeInTheDocument();
    expect(screen.queryByTestId('person-pane-notes-failed')).not.toBeInTheDocument();
  });
});

/**
 * Two things ThreadPane's notes panel had and the rewrite dropped. Both answer
 * the same question — "is this note still true?" — which is the only question
 * anyone asks of a handover note.
 */
describe('PersonPane — a note carries its date, and the panel carries its count', () => {
  const NOTES = [
    { id: 'n1', body: 'Fiyat listesi gönderildi', createdAt: '2026-08-20T10:00:00Z' },
    { id: 'n2', body: 'Muhasebeye devredildi', createdAt: '2026-08-21T11:30:00Z' },
  ];

  beforeEach(() => {
    get.mockImplementation((url: string) =>
      String(url).includes('/notes')
        ? Promise.resolve({ data: NOTES })
        : Promise.resolve({ data: [] }),
    );
  });

  it('counts the notes on the closed panel, so nobody has to open it to find out', async () => {
    const user = userEvent.setup();
    renderPane();

    // Open once to let the query run, close again: the count has to survive on
    // the collapsed header, which is where it does its work.
    const toggle = await screen.findByRole('button', { name: /İç notlar/ });
    await user.click(toggle);
    await screen.findByText('Fiyat listesi gönderildi');
    await user.click(toggle);

    expect(await screen.findByTestId('person-pane-notes-count')).toHaveTextContent('2');
  });

  it('dates each note — an undated handover note cannot be told from a stale one', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(await screen.findByRole('button', { name: /İç notlar/ }));

    const note = await screen.findByTestId('person-pane-note-n1');
    expect(note).toHaveTextContent('Fiyat listesi gönderildi');
    expect(within(note).getByTestId('person-pane-note-at-n1')).not.toBeEmptyDOMElement();
  });
});

/**
 * The thread picker exists because selecting a PERSON no longer selects a
 * channel. Labelling it by `channel.type` alone works right up until the two
 * threads are on the same channel — and then it draws two identical `SMS`
 * buttons with nothing whatsoever to choose between them, which is the failure
 * the picker was added to prevent, one level down: the rep picks one at random
 * and answers the wrong thread.
 */
describe('PersonPane — two threads on one channel are still two threads', () => {
  it('tells same-channel threads apart by when they were last spoken on', async () => {
    listConversations.mockResolvedValue([
      thread({ id: 'c-new', channel: { type: 'SMS' }, lastMessageAt: '2026-08-20T10:00:00Z' }),
      thread({ id: 'c-old', channel: { type: 'SMS' }, lastMessageAt: '2026-06-05T10:00:00Z' }),
    ]);

    renderPane();

    const picker = await screen.findByRole('group', { name: 'Konuşma' });
    const [newer, older] = within(picker).getAllByRole('button');
    // Both still say what channel they are.
    expect(newer).toHaveTextContent('SMS');
    expect(older).toHaveTextContent('SMS');
    // And they are no longer the same button twice.
    expect(newer.textContent).not.toEqual(older.textContent);
  });

  it('marks a closed thread, so nobody replies into one by accident', async () => {
    listConversations.mockResolvedValue([
      thread({ id: 'c-open', channel: { type: 'SMS' }, lastMessageAt: '2026-08-20T10:00:00Z' }),
      thread({
        id: 'c-done',
        status: 'CLOSED',
        channel: { type: 'SMS' },
        lastMessageAt: '2026-06-05T10:00:00Z',
      }),
    ]);

    renderPane();

    const picker = await screen.findByRole('group', { name: 'Konuşma' });
    const [, closed] = within(picker).getAllByRole('button');
    expect(closed).toHaveTextContent('Kapalı');
    expect(within(picker).getAllByRole('button')[0]).not.toHaveTextContent('Kapalı');
  });
});
