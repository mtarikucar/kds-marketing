import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
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
  it('says why the AI is silent on this thread instead of leaving it a mystery', async () => {
    // "The AI isn't answering" is a support ticket. The same sentence shown
    // next to the thread is a fix the person can make themselves — attach an
    // agent, resume the conversation, top up the key.
    listConversations.mockResolvedValue([
      thread({ aiLastDeclineReason: 'no agent profile attached to channel SMS' }),
    ]);

    renderPane();

    expect(await screen.findByTestId('ai-decline-reason')).toHaveTextContent(
      'no agent profile attached to channel SMS',
    );
  });

  it('names a coded decline in the reader’s language, not the server’s prose', async () => {
    // The engine prefixes a machine code onto its own English sentence. The
    // sentence is for whoever is reading the database during an incident; the
    // rep gets the translated one (PLAN G8 — a reason code is never printed raw).
    listConversations.mockResolvedValue([
      thread({
        aiLastDeclineReason: 'CONVERSATION_NOT_OPEN: conversation is CLOSED, not OPEN',
      }),
    ]);

    renderPane();

    const row = await screen.findByTestId('ai-decline-reason');
    expect(row).toHaveTextContent('This conversation is closed');
    expect(row).not.toHaveTextContent('not OPEN');
  });

  it('falls back to the prose for a code this build does not know', async () => {
    // The SPA and the API deploy separately, so a newer server can name a code
    // this bundle has never heard of. Prose is degraded; blank is broken.
    listConversations.mockResolvedValue([
      thread({ aiLastDeclineReason: 'SOME_NEW_CODE: the engine said something new' }),
    ]);

    renderPane();

    expect(await screen.findByTestId('ai-decline-reason')).toHaveTextContent(
      'SOME_NEW_CODE: the engine said something new',
    );
  });

  it('shows nothing when the AI has not declined anything', async () => {
    // The quiet case is the common one; a permanently empty row would be noise
    // on every healthy thread.
    renderPane();
    await screen.findByTestId('stream');
    expect(screen.queryByTestId('ai-decline-reason')).not.toBeInTheDocument();
  });

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

/**
 * A 2xx from `POST /conversations/:id/reply` is the REQUEST succeeding, not the
 * send. `MessageSenderService` catches an adapter rejection, persists the
 * Message as FAILED with the provider's reason, refunds the quota and RETURNS —
 * so the composer used to clear the box, show nothing, and leave the rep
 * believing a letter went out that never left the building. Worse: `reply()`
 * pauses the AI for the thread before it sends, so the failure left the
 * customer with nobody answering at all.
 *
 * The same distinction `LeadHeaderActions` already makes one component over.
 */
describe('PersonPane — a send that failed is not a send that happened', () => {
  const failed = (error?: string | null) => ({
    data: { id: 'm1', status: 'FAILED', error: error ?? null },
  });

  const typeAndSend = async (user: ReturnType<typeof userEvent.setup>, text = 'Uzun bir yanıt') => {
    const box = await screen.findByLabelText('Yanıt yaz');
    await user.type(box, text);
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    return box;
  };

  it('keeps the rep’s letter in the box when the provider refused it', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue(failed('550 mailbox unavailable'));
    renderPane();

    const box = await typeAndSend(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The whole point: Gönder is the retry, so what was typed has to still be
    // there to retry with.
    expect((box as HTMLInputElement).value).toBe('Uzun bir yanıt');
  });

  it('names the provider’s reason instead of failing silently', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue(failed('550 mailbox unavailable'));
    renderPane();

    await typeAndSend(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('550 mailbox unavailable'),
      ),
    );
    // And says the other half of the truth: the AI was paused by this very
    // reply, so nobody is answering this customer until somebody retries.
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('yapay zekâ'));
  });

  it('still says "Gönderilemedi" when the row carries no reason', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue(failed(null));
    renderPane();

    await typeAndSend(user, 'kısa');

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Gönderilemedi')),
    );
  });

  it('refreshes the thread on a FAILED send too — the bubble is where the reason lives', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue(failed('550'));
    renderPane();

    await typeAndSend(user, 'x');

    // The FAILED Message row exists; a list left un-invalidated would keep
    // showing a thread that never mentions it.
    await waitFor(() => expect(listConversations.mock.calls.length).toBeGreaterThan(1));
  });

  it('clears the box when the send actually left', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: { id: 'm1', status: 'SENT' } });
    renderPane();

    const box = await typeAndSend(user, 'gitti');

    await waitFor(() => expect((box as HTMLInputElement).value).toBe(''));
    expect(toast.error).not.toHaveBeenCalled();
  });

  // The other failure shape: the request itself is refused (a non-ACTIVE
  // channel, MESSAGES_EXHAUSTED). Same rule — the letter stays.
  it('keeps the box when the request itself is refused, and repeats the server’s words', async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({ response: { data: { message: 'Channel is INACTIVE, not ACTIVE' } } });
    renderPane();

    const box = await typeAndSend(user, 'deneme');

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Channel is INACTIVE, not ACTIVE'),
    );
    expect((box as HTMLInputElement).value).toBe('deneme');
  });
});

/**
 * An email reply is a letter, not a text message.
 *
 * The composer was one `<input>` for every channel, so a formal answer to a
 * B2B enquiry went out as a single run-on line. Widening it is only half the
 * fix: the key that sends has to change with it, because Enter now has a job
 * inside the box — and the SMS side must NOT change, since plain Enter is what
 * the higher-traffic channel's reps use all day.
 */
describe('PersonPane — an email reply is a letter, not a text message', () => {
  const mailThread = (over: Record<string, unknown> = {}) =>
    thread({ id: 'c-mail', channel: { type: 'EMAIL' }, ...over });

  const replyCalls = () =>
    post.mock.calls.filter(([url]) => String(url).includes('/reply')).length;

  it('gives EMAIL a multi-line box, and Enter writes a newline instead of sending', async () => {
    const user = userEvent.setup();
    listConversations.mockResolvedValue([mailThread()]);
    renderPane();

    const box = (await screen.findByLabelText('Yanıt yaz')) as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');

    await user.type(box, 'Merhaba,{Enter}{Enter}Teklifi ekte gönderiyorum.');

    expect(box.value).toContain('\n');
    expect(replyCalls()).toBe(0);
  });

  it('sends on Ctrl+Enter', async () => {
    const user = userEvent.setup();
    listConversations.mockResolvedValue([mailThread()]);
    renderPane();

    const box = await screen.findByLabelText('Yanıt yaz');
    await user.type(box, 'Merhaba');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/conversations/c-mail/reply', { text: 'Merhaba' }),
    );
  });

  it('sends ONCE while the first send is still in flight', async () => {
    // The guard the single-line box has always carried, kept verbatim on the
    // new key path: a second press re-sending the not-yet-cleared draft is a
    // duplicate letter to a live customer.
    const user = userEvent.setup();
    listConversations.mockResolvedValue([mailThread()]);
    post.mockImplementation((url: string) =>
      String(url).includes('/reply') ? new Promise(() => undefined) : Promise.resolve({ data: {} }),
    );
    renderPane();

    const box = await screen.findByLabelText('Yanıt yaz');
    await user.type(box, 'Merhaba');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(replyCalls()).toBe(1));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(replyCalls()).toBe(1);
  });

  it('shows how much room is left before the server refuses the letter', async () => {
    // The 4000-char cap is `ReplyDto.text`'s; unannounced it arrives as a 400
    // with the rep's whole letter in the request body.
    const user = userEvent.setup();
    listConversations.mockResolvedValue([mailThread()]);
    renderPane();

    const box = (await screen.findByLabelText('Yanıt yaz')) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(4000);

    await user.type(box, 'abc');
    expect(screen.getByTestId('person-pane-composer-meta')).toHaveTextContent('3/4000');
  });

  it('leaves SMS on plain Enter, with its segment counter', async () => {
    // Moving the higher-traffic channel to Ctrl+Enter would be a regression
    // for the reps who live in it.
    const user = userEvent.setup();
    renderPane();

    const box = await screen.findByLabelText('Yanıt yaz');
    expect((box as HTMLElement).tagName).toBe('INPUT');

    await user.type(box, 'Merhaba{Enter}');

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/conversations/c1/reply', { text: 'Merhaba' }),
    );
    expect(screen.getByTestId('person-pane-composer-meta')).toHaveTextContent('parça');
  });
});

/**
 * Which address this reply is about to leave for.
 *
 * The composer named the CHANNEL and nothing else, so a thread opened against
 * `ahmet@eski.com` kept mailing it after the lead's address was corrected —
 * unseen, because nothing on the surface ever prints the address a thread is
 * bound to. The identity is the threading key and is deliberately NOT
 * re-pointed by a lead edit, so the answer is to say what it is, and to say so
 * when the lead has moved on.
 */
describe('PersonPane — the composer says which address it is about to mail', () => {
  it('names the address the thread actually mails', async () => {
    listConversations.mockResolvedValue([
      thread({
        id: 'c-mail',
        channel: { type: 'EMAIL' },
        contact: { value: 'ahmet@acme.com', kind: 'EMAIL' },
      }),
    ]);

    renderPane({ person: person({ email: 'ahmet@acme.com' }) });

    expect(await screen.findByTestId('person-pane-composer-meta')).toHaveTextContent(
      'EMAIL · ahmet@acme.com',
    );
  });

  it('falls back to the lead’s own address, so correcting the lead corrects the box', async () => {
    listConversations.mockResolvedValue([thread({ id: 'c-mail', channel: { type: 'EMAIL' } })]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (email: string) => (
      <QueryClientProvider client={qc}>
        <PersonPane person={person({ email })} />
      </QueryClientProvider>
    );

    const { rerender } = render(ui('eski@acme.com'));
    expect(await screen.findByTestId('person-pane-composer-meta')).toHaveTextContent(
      'eski@acme.com',
    );

    rerender(ui('yeni@acme.com'));
    await waitFor(() =>
      expect(screen.getByTestId('person-pane-composer-meta')).toHaveTextContent('yeni@acme.com'),
    );
  });

  it('warns when the thread still points at an address the lead no longer uses', async () => {
    listConversations.mockResolvedValue([
      thread({
        id: 'c-mail',
        channel: { type: 'EMAIL' },
        contact: { value: 'Ahmet@Eski.com ', kind: 'EMAIL' },
      }),
    ]);

    renderPane({ person: person({ email: 'yeni@acme.com' }) });

    expect(await screen.findByTestId('person-pane-recipient-stale')).toBeInTheDocument();
    // And it still says where the mail is really going, rather than the
    // address the rep would assume from the lead record.
    expect(screen.getByTestId('person-pane-composer-meta')).toHaveTextContent('Ahmet@Eski.com');
  });

  it('says nothing when the two spellings are the same address', async () => {
    listConversations.mockResolvedValue([
      thread({
        id: 'c-mail',
        channel: { type: 'EMAIL' },
        contact: { value: '  Ahmet@Acme.com', kind: 'EMAIL' },
      }),
    ]);

    renderPane({ person: person({ email: 'ahmet@acme.com' }) });

    await screen.findByTestId('person-pane-composer-meta');
    expect(screen.queryByTestId('person-pane-recipient-stale')).not.toBeInTheDocument();
  });

  it('never warns on a phone thread', async () => {
    // Identities are stored E.164 while `lead.phone` keeps whatever shape it
    // arrived in, so a raw compare would warn on virtually every SMS thread.
    listConversations.mockResolvedValue([
      thread({ id: 'c-sms', channel: { type: 'SMS' }, contact: { value: '+905551112233', kind: 'PHONE' } }),
    ]);

    renderPane({ person: person({ phone: '0555 111 22 33' }) });

    await screen.findByTestId('person-pane-composer-meta');
    expect(screen.queryByTestId('person-pane-recipient-stale')).not.toBeInTheDocument();
  });

  it('tells two same-channel threads apart by the address each one mails', async () => {
    // The merge case: two EMAIL threads on one person differ by nothing a
    // channel label can show.
    listConversations.mockResolvedValue([
      thread({
        id: 'c-new',
        channel: { type: 'EMAIL' },
        lastMessageAt: '2026-08-20T10:00:00Z',
        contact: { value: 'yeni@acme.com', kind: 'EMAIL' },
      }),
      thread({
        id: 'c-old',
        channel: { type: 'EMAIL' },
        lastMessageAt: '2026-06-05T10:00:00Z',
        contact: { value: 'eski@acme.com', kind: 'EMAIL' },
      }),
    ]);

    renderPane();

    const picker = await screen.findByRole('group', { name: 'Konuşma' });
    const [newer, older] = within(picker).getAllByRole('button');
    expect(newer).toHaveTextContent('yeni@acme.com');
    expect(older).toHaveTextContent('eski@acme.com');
  });

  it('adopts the address the server says it mailed, once it has said so', async () => {
    // Until the list endpoint carries the identity, the reply response is the
    // only first-hand witness to where a thread's mail actually went.
    const user = userEvent.setup();
    listConversations.mockResolvedValue([thread({ id: 'c-mail', channel: { type: 'EMAIL' } })]);
    post.mockResolvedValue({ data: { id: 'm1', status: 'SENT', to: 'ahmet@eski.com' } });

    renderPane({ person: person({ email: 'yeni@acme.com' }) });

    const box = await screen.findByLabelText('Yanıt yaz');
    await user.type(box, 'selam');
    await user.click(screen.getByRole('button', { name: 'Gönder' }));

    await waitFor(() =>
      expect(screen.getByTestId('person-pane-composer-meta')).toHaveTextContent('ahmet@eski.com'),
    );
    expect(screen.getByTestId('person-pane-recipient-stale')).toBeInTheDocument();
  });
});
