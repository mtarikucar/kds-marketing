import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConversationsTab from './ConversationsTab';
import * as conversationsService from '../../../features/marketing/api/conversations.service';
import type { ConversationSummary } from '../../../features/marketing/api/conversations.service';

// Sibling convention (TimelinePanel.test.tsx): mock the SERVICE MODULE by path
// and drive it through `vi.mocked`, rather than spying on a namespace object.
vi.mock('../../../features/marketing/api/conversations.service');

const listConversations = vi.mocked(conversationsService.listConversations);

const convo = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1',
  status: 'OPEN',
  aiPaused: false,
  unreadCount: 0,
  lastMessageAt: '2026-08-29T09:00:00Z',
  channel: { id: 'ch1', type: 'whatsapp', name: 'WhatsApp' },
  lastMessage: { body: 'Fiyat listesini alabilir miyim?', direction: 'INBOUND' },
  ...over,
});

const fmtDate = (d: string | Date | null | undefined) => (d ? String(d).slice(0, 10) : '');

function renderTab(leadId = 'lead-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactNode) =>
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  return wrap(<ConversationsTab leadId={leadId} fmtDate={fmtDate} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  listConversations.mockResolvedValue([]);
});

describe('ConversationsTab', () => {
  it('lists this lead’s threads across every channel', async () => {
    listConversations.mockResolvedValue([
      convo({ id: 'c1', channel: { id: 'ch1', type: 'whatsapp', name: 'WhatsApp' } }),
      convo({
        id: 'c2',
        channel: { id: 'ch2', type: 'email', name: 'Destek' },
        lastMessage: { body: 'Sözleşmeyi ilettim', direction: 'OUTBOUND' },
      }),
    ]);

    renderTab();

    expect(await screen.findByTestId('conversation-c1')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-c2')).toBeInTheDocument();
    expect(screen.getByText(/Fiyat listesini alabilir miyim\?/)).toBeInTheDocument();
    expect(screen.getByText(/Sözleşmeyi ilettim/)).toBeInTheDocument();
  });

  // Without the leadId the tab lists EVERY thread in the workspace and looks
  // completely normal — the same silent-scope bug the Satış tab guards against.
  it('asks the API for only this lead’s threads', async () => {
    renderTab('lead-42');
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    expect(listConversations).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'lead-42' }));
  });

  it('says there are no conversations rather than showing a blank box', async () => {
    renderTab();
    expect(await screen.findByText(/Bu kişiyle henüz konuşulmadı/)).toBeInTheDocument();
  });

  // THE load-bearing case. "Nothing to show" and "could not load" are the same
  // blank panel if the error is swallowed — this codebase has already paid for
  // that conflation once (eight daily-digest queries reporting "nothing to
  // report" for eight weeks while the query was actually throwing). Asserting
  // that an alert appears is not enough: the empty state must be ABSENT.
  it('reports a failed fetch instead of an empty conversation list', async () => {
    listConversations.mockRejectedValue(new Error('boom'));

    renderTab();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Bu kişiyle henüz konuşulmadı/)).not.toBeInTheDocument();
  });
});
