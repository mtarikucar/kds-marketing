import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LeadStream from './LeadStream';
import * as leadStreamService from '../api/leadStream.service';
import type { LeadStream as LeadStreamPayload, LeadStreamItem } from '../api/leadStream.service';

// Sibling convention (TimelinePanel.test.tsx, ConversationsTab.test.tsx): mock
// the SERVICE MODULE by path and drive it through `vi.mocked`.
vi.mock('../api/leadStream.service');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const getLeadStream = vi.mocked(leadStreamService.getLeadStream);

/**
 * Every field the backend always sends, defaulted to null — so a fixture says
 * only what the case under test is about, and a test can never accidentally
 * assert on a field it forgot to set.
 */
const item = (
  over: Partial<LeadStreamItem> & Pick<LeadStreamItem, 'kind' | 'id' | 'at'>,
): LeadStreamItem => ({
  title: null,
  body: null,
  direction: null,
  authorType: null,
  conversationId: null,
  channelId: null,
  channelType: null,
  deliveryStatus: null,
  error: null,
  activityType: null,
  outcome: null,
  durationMinutes: null,
  authorId: null,
  authorName: null,
  ...over,
});

const stream = (over: Partial<LeadStreamPayload> = {}): LeadStreamPayload => ({
  leadId: 'l1',
  items: [],
  unread: [],
  truncated: [],
  gated: [],
  ...over,
});

function renderStream(node: ReactNode = <LeadStream leadId="l1" />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  getLeadStream.mockResolvedValue(stream());
});

describe('LeadStream — one person, one axis', () => {
  it('asks for THIS lead’s stream', async () => {
    renderStream(<LeadStream leadId="lead-42" />);
    await waitFor(() => expect(getLeadStream).toHaveBeenCalledWith('lead-42'));
  });

  // Five kinds rendered identically is the "undifferentiated mush" the design
  // exists to prevent. A message is a CONVERSATION BUBBLE with a side; a call,
  // a note and a status move are TIMELINE EVENTS and must not be bubbles —
  // otherwise a status change reads as something the customer said.
  it('draws messages as sided bubbles and activities as timeline events', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm1',
            at: '2026-08-01T09:00:00Z',
            body: 'Merhaba',
            direction: 'INBOUND',
            authorType: 'CUSTOMER',
          }),
          item({
            kind: 'message',
            id: 'm2',
            at: '2026-08-01T09:05:00Z',
            body: 'Merhaba, buyurun',
            direction: 'OUTBOUND',
            authorType: 'AGENT',
          }),
          item({
            kind: 'call',
            id: 'a1',
            at: '2026-08-02T09:00:00Z',
            title: 'Aradım',
            outcome: 'POSITIVE',
            durationMinutes: 12,
          }),
          item({ kind: 'note', id: 'a2', at: '2026-08-03T09:00:00Z', title: 'Fiyat notu' }),
          item({ kind: 'status', id: 'a3', at: '2026-08-04T09:00:00Z', title: 'NEW -> CONTACTED' }),
        ],
      }),
    );

    renderStream();

    const inbound = await screen.findByTestId('stream-item-m1');
    expect(inbound).toHaveAttribute('data-shape', 'bubble');
    expect(inbound).toHaveAttribute('data-direction', 'INBOUND');
    expect(screen.getByTestId('stream-item-m2')).toHaveAttribute('data-direction', 'OUTBOUND');

    for (const id of ['a1', 'a2', 'a3']) {
      expect(screen.getByTestId(`stream-item-${id}`)).toHaveAttribute('data-shape', 'event');
    }
    // …and the event rows keep their own kinds rather than collapsing to one.
    expect(screen.getByTestId('stream-item-a1')).toHaveAttribute('data-kind', 'call');
    expect(screen.getByTestId('stream-item-a2')).toHaveAttribute('data-kind', 'note');
    expect(screen.getByTestId('stream-item-a3')).toHaveAttribute('data-kind', 'status');
  });

  // The array arrives oldest -> newest and renders in that order: newest at the
  // BOTTOM, the way a conversation reads. Reversing it silently would still
  // show every row.
  it('renders oldest first so the newest is at the bottom', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({ kind: 'note', id: 'old', at: '2026-01-01T09:00:00Z', title: 'İlk temas' }),
          item({ kind: 'note', id: 'new', at: '2026-08-01T09:00:00Z', title: 'Son not' }),
        ],
      }),
    );

    renderStream();
    await screen.findByTestId('stream-item-old');

    const ids = screen.getAllByTestId(/^stream-item-/).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['stream-item-old', 'stream-item-new']);
  });

  // The live gap this component closes. v2.283.0's ConversationsTab rendered
  // `lastMessage.body` with NO failure indicator, so a message that never left
  // the building sat in the list reading exactly like a delivered one. The
  // status has to be on the MESSAGE, with the provider's reason — a toast that
  // has already disappeared is not a record.
  it('says a FAILED message did not send, on the message, with its error', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm9',
            at: '2026-08-01T09:00:00Z',
            body: 'Sözleşmeyi ilettim',
            direction: 'OUTBOUND',
            authorType: 'AGENT',
            deliveryStatus: 'FAILED',
            error: 'Numara operatörde kayıtlı değil',
          }),
        ],
      }),
    );

    renderStream();

    const bubble = await screen.findByTestId('stream-item-m9');
    expect(bubble).toHaveAttribute('data-delivery', 'FAILED');
    const failure = within(bubble).getByTestId('stream-failed-m9');
    expect(failure).toHaveTextContent('Gönderilemedi');
    expect(failure).toHaveTextContent('Numara operatörde kayıtlı değil');
  });

  it('does not mark a delivered message as failed', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm8',
            at: '2026-08-01T09:00:00Z',
            body: 'Geldi',
            direction: 'OUTBOUND',
            deliveryStatus: 'DELIVERED',
          }),
        ],
      }),
    );

    renderStream();
    // Positive anchor first — a `queryBy…` against a still-loading component
    // finds nothing and would pass with the indicator unconditionally on.
    await screen.findByTestId('stream-item-m8');
    expect(screen.queryByTestId('stream-failed-m8')).not.toBeInTheDocument();
  });
});

/**
 * The backend keeps `unread`, `truncated` and `gated` as three lists on
 * purpose, and the whole point is that they mean three different things:
 * COULD NOT READ IT / READ IT, THERE WAS MORE / THE PLAN DOES NOT INCLUDE IT.
 * Collapsing any two of them sends a customer to the wrong place — support
 * instead of billing, or an engineer instead of a scroll.
 */
describe('LeadStream — three signals, kept apart', () => {
  it('names a source that could not be read', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [item({ kind: 'note', id: 'a1', at: '2026-08-01T09:00:00Z', title: 'Not' })],
        unread: ['mesajlar'],
      }),
    );

    renderStream();

    const line = await screen.findByTestId('stream-unread');
    expect(line).toHaveTextContent('mesajlar');
    expect(line).toHaveTextContent('okunamadı');
    // The half that DID load is still here — one broken source must not empty
    // the stream.
    expect(screen.getByTestId('stream-item-a1')).toBeInTheDocument();
  });

  it('says a source was cut rather than that it failed', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [item({ kind: 'note', id: 'a1', at: '2026-08-01T09:00:00Z', title: 'Not' })],
        truncated: ['mesajlar'],
      }),
    );

    renderStream();

    const line = await screen.findByTestId('stream-truncated');
    expect(line).toHaveTextContent('daha eski kayıtlar var');
    expect(screen.queryByTestId('stream-unread')).not.toBeInTheDocument();
  });

  // A workspace without `conversationAi` is NOT broken. It receives its
  // activities plus gated: ['mesajlar'], and the sentence it reads has to send
  // it to billing, not to support.
  it('phrases a gated source as a plan limit, never as a failure', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [item({ kind: 'note', id: 'a1', at: '2026-08-01T09:00:00Z', title: 'Not' })],
        gated: ['mesajlar'],
      }),
    );

    renderStream();

    const line = await screen.findByTestId('stream-gated');
    expect(line).toHaveTextContent('mesajlar');
    expect(line).toHaveTextContent('paketine dahil değil');
    expect(line).not.toHaveTextContent('okunamadı');
    // Not an error state: no alert, and the activities the workspace DOES own
    // are on screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('stream-item-a1')).toBeInTheDocument();
  });

  it('keeps all three as three separate lines when all three are set', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [item({ kind: 'note', id: 'a1', at: '2026-08-01T09:00:00Z', title: 'Not' })],
        unread: ['yazarlar'],
        truncated: ['hareketler'],
        gated: ['mesajlar'],
      }),
    );

    renderStream();

    await screen.findByTestId('stream-unread');
    expect(screen.getByTestId('stream-unread')).toHaveTextContent('yazarlar');
    expect(screen.getByTestId('stream-truncated')).toHaveTextContent('hareketler');
    expect(screen.getByTestId('stream-gated')).toHaveTextContent('mesajlar');
    // Three lines, not one merged "something is missing".
    expect(screen.getByTestId('stream-unread')).not.toHaveTextContent('hareketler');
    expect(screen.getByTestId('stream-gated')).not.toHaveTextContent('hareketler');
  });
});

/**
 * The repo's central rule: a failed fetch must never render as "nothing
 * happened yet". This component has TWO ways to break it — the query itself
 * throwing, and the query succeeding while one of its sources failed.
 */
describe('LeadStream — a failure is never an empty stream', () => {
  it('reports a failed fetch instead of an empty stream', async () => {
    getLeadStream.mockRejectedValue(new Error('boom'));

    renderStream();

    expect(await screen.findByRole('alert')).toHaveTextContent('Akış yüklenemedi.');
    expect(screen.queryByTestId('stream-empty')).not.toBeInTheDocument();
  });

  // The subtler half: 200 OK, zero items, and `unread` naming the source that
  // blew up. "Henüz bir şey yok" would be a lie told with a straight face.
  it('does not claim an empty history when a source could not be read', async () => {
    getLeadStream.mockResolvedValue(stream({ items: [], unread: ['hareketler'] }));

    renderStream();

    await screen.findByTestId('stream-unread');
    expect(screen.queryByTestId('stream-empty')).not.toBeInTheDocument();
  });

  it('says the history is empty when it genuinely is', async () => {
    getLeadStream.mockResolvedValue(stream({ items: [] }));

    renderStream();

    expect(await screen.findByTestId('stream-empty')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('LeadStream — composition', () => {
  // The surface agent sends messages; this component does not. The slot exists
  // so their composer sits under the stream without this file growing a
  // second, conflicting send path.
  it('renders the composer slot it is given', async () => {
    getLeadStream.mockResolvedValue(stream({ items: [] }));

    renderStream(<LeadStream leadId="l1" composer={<div data-testid="composer" />} />);

    expect(await screen.findByTestId('composer')).toBeInTheDocument();
  });

  // Spec §IA: system/automatic things recede, the human's work is prominent.
  // Same one-expression treatment as TimelinePanel — the row PUBLISHES its
  // weight, so the styling can be retuned but a row cannot report recessive
  // and be drawn prominent.
  it('lets automatic rows recede and keeps human work prominent', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({ kind: 'status', id: 'a1', at: '2026-08-01T09:00:00Z', title: 'NEW -> CONTACTED' }),
          item({ kind: 'call', id: 'a2', at: '2026-08-02T09:00:00Z', title: 'Aradım' }),
          item({
            kind: 'activity',
            id: 'a3',
            at: '2026-08-03T09:00:00Z',
            title: 'Sistem kaydı',
            authorType: 'SYSTEM',
          }),
        ],
      }),
    );

    renderStream();

    await screen.findByTestId('stream-item-a1');
    expect(screen.getByTestId('stream-item-a1')).toHaveAttribute('data-weight', 'recessive');
    expect(screen.getByTestId('stream-item-a3')).toHaveAttribute('data-weight', 'recessive');
    expect(screen.getByTestId('stream-item-a2')).toHaveAttribute('data-weight', 'normal');
  });
});
