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
