import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LeadStream from './LeadStream';
import * as leadStreamService from '../api/leadStream.service';
import type { LeadStream as LeadStreamPayload, LeadStreamItem } from '../api/leadStream.service';

// Sibling convention (TimelinePanel.test.tsx, ConversationsTab.test.tsx): mock
// the SERVICE MODULE by path and drive it through `vi.mocked`.
vi.mock('../api/leadStream.service');
// The two panels the call rows mount are the REAL ones - reusing them is the
// point of the merge, so stubbing them would test nothing. Their transport is
// what gets mocked.
vi.mock('../api/voice-ai.service', async () => {
  const actual = await vi.importActual<typeof import('../api/voice-ai.service')>(
    '../api/voice-ai.service',
  );
  return {
    ...actual,
    getCallRecording: (...a: unknown[]) => getCallRecording(...a),
    getCallAnalysis: (...a: unknown[]) => getCallAnalysis(...a),
    runCallAnalysis: (...a: unknown[]) => runCallAnalysis(...a),
  };
});
const { getCallRecording, getCallAnalysis, runCallAnalysis } = vi.hoisted(() => ({
  getCallRecording: vi.fn(),
  getCallAnalysis: vi.fn(),
  runCallAnalysis: vi.fn(),
}));

/**
 * `t` normally answers with the inline Turkish default, which is what every
 * assertion below reads. `I18N.mode = 'keys'` flips it to answer with the KEY
 * instead - the only way to prove a string goes THROUGH the catalogue rather
 * than being printed verbatim, because for a Turkish-defaulted key the two are
 * the same characters.
 */
const I18N = vi.hoisted(() => ({ mode: 'defaults' as 'defaults' | 'keys' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) => {
      const k = Array.isArray(key) ? key[0] : key;
      if (I18N.mode === 'keys') return k;
      return (typeof opts === 'string' ? opts : opts?.defaultValue) ?? k;
    },
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
  meta: null,
  activityType: null,
  outcome: null,
  durationMinutes: null,
  assignment: null,
  callId: null,
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
  I18N.mode = 'defaults';
  getLeadStream.mockResolvedValue(stream());
  getCallRecording.mockResolvedValue({ url: 'https://cdn.test/rec.mp3' });
  getCallAnalysis.mockResolvedValue({ status: 'NONE' });
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

/**
 * The backend names a failed / cut / withheld source in ITS OWN language:
 * `mesajlar`, `hareketler`, `yazarlar`. Printing that token verbatim drops a
 * Turkish word into the middle of an Arabic, Russian or Uzbek sentence — and
 * it is the one part of these three lines an operator has to read to know WHAT
 * is missing.
 */
describe('LeadStream — the missing source is named in the reader’s language', () => {
  const named = (over: Partial<LeadStreamPayload>) =>
    getLeadStream.mockResolvedValue(
      stream({
        items: [item({ kind: 'note', id: 'a1', at: '2026-08-01T09:00:00Z', title: 'Not' })],
        ...over,
      }),
    );

  it('translates the source token on all three lines', async () => {
    I18N.mode = 'keys';
    named({ unread: ['mesajlar'], truncated: ['hareketler'], gated: ['yazarlar'] });

    renderStream();

    // The KEY, not the Turkish token — which is exactly what a verbatim
    // `join(', ')` renders, identically, in every locale.
    expect(await screen.findByTestId('stream-unread')).toHaveTextContent(
      'leadDetail.stream.source.mesajlar',
    );
    expect(screen.getByTestId('stream-truncated')).toHaveTextContent(
      'leadDetail.stream.source.hareketler',
    );
    expect(screen.getByTestId('stream-gated')).toHaveTextContent(
      'leadDetail.stream.source.yazarlar',
    );
  });

  it('still prints a source it has no name for, rather than an empty sentence', async () => {
    // A source added to the backend tomorrow must not turn "X could not be
    // read" into " could not be read".
    I18N.mode = 'keys';
    named({ unread: ['kartvizitler'] });

    renderStream();

    expect(await screen.findByTestId('stream-unread')).toHaveTextContent('kartvizitler');
  });

  it('still reads as Turkish for a Turkish operator', async () => {
    named({ unread: ['mesajlar'] });

    renderStream();

    expect(await screen.findByTestId('stream-unread')).toHaveTextContent('mesajlar');
  });
});

/**
 * The regression this restores. `LeadActivity.metadata` is the only thing
 * separating an auto-distribution from a bulk assign from a manual one — all
 * three are STATUS_CHANGE rows whose titles begin with the same word. The old
 * ActivityTimeline badged them apart; Akış lost the badge along with the
 * metadata the endpoint never carried.
 */
describe('LeadStream — how someone got assigned', () => {
  const assigned = (assignment: LeadStreamItem['assignment'], title: string) =>
    getLeadStream.mockResolvedValue(
      stream({
        items: [item({ kind: 'status', id: 'a1', at: '2026-08-01T09:00:00Z', title, assignment })],
      }),
    );

  it('badges an automatic assignment apart from a manual one', async () => {
    assigned('auto', 'Auto-assigned on ingest');
    renderStream();

    expect(await screen.findByTestId('stream-assignment-a1')).toHaveTextContent('Otomatik');
  });

  it('badges a bulk assignment as bulk', async () => {
    assigned('bulk', 'Assigned to Ayşe');
    renderStream();

    expect(await screen.findByTestId('stream-assignment-a1')).toHaveTextContent('Toplu');
  });

  it('leaves a manual assignment unbadged — a person did it, that is the norm', async () => {
    assigned('manual', 'Reassigned: Ayşe → Mehmet');
    renderStream();

    // Anchor on the row before asserting the badge is absent: a queryBy
    // against a still-loading component finds nothing and passes for free.
    await screen.findByTestId('stream-item-a1');
    expect(screen.queryByTestId('stream-assignment-a1')).not.toBeInTheDocument();
  });

  it('never badges a plain stage move', async () => {
    assigned(null, 'NEW -> CONTACTED');
    renderStream();

    await screen.findByTestId('stream-item-a1');
    expect(screen.queryByTestId('stream-assignment-a1')).not.toBeInTheDocument();
  });
});

/**
 * A voicemail and a fax arrive as ordinary inbound MESSAGES tagged in
 * `meta.raw.kind` — a Message has no channel column of its own. The inbox's
 * thread pane rendered the audio player and the document link off that
 * payload; this stream replaces that pane, so it renders them or they vanish
 * with no error anywhere.
 */
describe('LeadStream — a voicemail is not a text message', () => {
  it('plays a voicemail rather than showing its transcript alone', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm1',
            at: '2026-08-01T09:00:00Z',
            body: 'Sesli mesaj metni',
            direction: 'INBOUND',
            authorType: 'CUSTOMER',
            meta: { raw: { kind: 'VOICEMAIL', audioUrl: 'https://p.test/vm.mp3', durationSec: 31 } },
          }),
        ],
      }),
    );

    renderStream();

    const bubble = await screen.findByTestId('stream-item-m1');
    expect(bubble).toHaveTextContent('Sesli mesaj');
    expect(within(bubble).getByTestId('stream-voicemail-m1')).toHaveAttribute(
      'src',
      'https://p.test/vm.mp3',
    );
  });

  it('links a fax to its document', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm2',
            at: '2026-08-01T09:00:00Z',
            body: 'Faks alındı',
            direction: 'INBOUND',
            meta: { raw: { kind: 'FAX', documentUrl: 'https://p.test/fax.pdf' } },
          }),
        ],
      }),
    );

    renderStream();

    expect(await screen.findByTestId('stream-fax-m2')).toHaveAttribute(
      'href',
      'https://p.test/fax.pdf',
    );
  });

  // ThreadPane's own guard, kept verbatim: the URL comes from a provider
  // payload nobody here controls, so anything that is not https is refused
  // rather than rendered as a document to click.
  it('refuses a fax link that is not https', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm3',
            at: '2026-08-01T09:00:00Z',
            body: 'Faks',
            direction: 'INBOUND',
            meta: { raw: { kind: 'FAX', documentUrl: 'javascript:alert(1)' } },
          }),
        ],
      }),
    );

    renderStream();

    const bubble = await screen.findByTestId('stream-item-m3');
    expect(bubble).toHaveTextContent('Faks');
    expect(within(bubble).queryByTestId('stream-fax-m3')).not.toBeInTheDocument();
  });

  it('leaves an ordinary message plain', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({
            kind: 'message',
            id: 'm4',
            at: '2026-08-01T09:00:00Z',
            body: 'Merhaba',
            direction: 'INBOUND',
          }),
        ],
      }),
    );

    renderStream();

    const bubble = await screen.findByTestId('stream-item-m4');
    expect(within(bubble).queryByTestId('stream-voicemail-m4')).not.toBeInTheDocument();
    expect(within(bubble).queryByTestId('stream-fax-m4')).not.toBeInTheDocument();
  });
});

/**
 * Auto-scroll. This is ThreadPane's three-way behaviour (ThreadPane.tsx:125-137
 * at 8f3ec48b), carried over rather than reinvented: the surface it replaced
 * jumped to the bottom of a freshly opened thread, followed the rep's OWN reply
 * down, and deliberately left an inbound message alone so a rep reading history
 * is not yanked away mid-sentence.
 *
 * It lives HERE, in the component that renders the messages, and not in the two
 * hosts that own the scroll box. `scrollIntoView` walks up to the nearest
 * scrollable ancestor, so owning the anchor never required owning the overflow —
 * and a behaviour a consumer has to opt into is a behaviour the third consumer
 * silently ships without.
 */
describe('LeadStream — you land on the newest, and you are not yanked off it', () => {
  let scrollIntoView: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
  });
  afterEach(() => scrollIntoView.mockRestore());

  const msg = (id: string, direction: 'INBOUND' | 'OUTBOUND', at: string) =>
    item({ kind: 'message', id, at, body: id, direction });

  const renderWithClient = (leadId = 'l1') => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LeadStream leadId={leadId} />
      </QueryClientProvider>,
    );
    return qc;
  };

  /** A second server answer, delivered the way a live frame delivers one. */
  const arrive = async (qc: QueryClient, leadId: string, items: LeadStreamItem[]) => {
    getLeadStream.mockResolvedValue(stream({ items }));
    await qc.invalidateQueries({ queryKey: ['marketing', 'lead', leadId, 'stream'] });
  };

  it('jumps to the newest message when the person opens, not the oldest', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          msg('m1', 'INBOUND', '2026-08-01T09:00:00Z'),
          msg('m2', 'INBOUND', '2026-08-02T09:00:00Z'),
        ],
      }),
    );

    renderWithClient();

    await screen.findByTestId('stream-item-m2');
    // 'auto', not 'smooth': opening someone should already BE at the bottom,
    // not animate there while the rep is reading.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto' }));
  });

  it('follows the rep’s own outbound reply down', async () => {
    getLeadStream.mockResolvedValue(
      stream({ items: [msg('m1', 'INBOUND', '2026-08-01T09:00:00Z')] }),
    );
    const qc = renderWithClient();
    await screen.findByTestId('stream-item-m1');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    await arrive(qc, 'l1', [
      msg('m1', 'INBOUND', '2026-08-01T09:00:00Z'),
      msg('m2', 'OUTBOUND', '2026-08-01T09:05:00Z'),
    ]);

    await screen.findByTestId('stream-item-m2');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' }));
  });

  it('leaves a rep reading history where they are when the CUSTOMER writes', async () => {
    getLeadStream.mockResolvedValue(
      stream({ items: [msg('m1', 'INBOUND', '2026-08-01T09:00:00Z')] }),
    );
    const qc = renderWithClient();
    await screen.findByTestId('stream-item-m1');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    await arrive(qc, 'l1', [
      msg('m1', 'INBOUND', '2026-08-01T09:00:00Z'),
      msg('m2', 'INBOUND', '2026-08-01T09:05:00Z'),
    ]);

    // Positive anchor: the new message really did render, so "did not scroll"
    // is a decision rather than a race that never got there.
    await screen.findByTestId('stream-item-m2');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});


/**
 * Until this block existed, a call in the stream was a DEAD END.
 *
 * The rep could see "Sales call: CONNECTED - 3 dk" and nothing else: the
 * recording and the AI analysis both hang off a `SalesCall.id`, and the
 * mirrored activity kept none - so hearing the call you just read about meant
 * leaving for /calls and finding the row again by phone number and timestamp.
 * The id now rides on the stream item (`callId`), and the two panels that
 * already knew how to render it are mounted here rather than rewritten.
 */
describe('LeadStream - a call you can actually play', () => {
  const call = (id: string, over: Partial<LeadStreamItem> = {}) =>
    item({
      kind: 'call',
      id,
      at: `2026-08-30T09:0${id.length}:00.000Z`,
      title: `Sales call ${id}`,
      ...over,
    });

  it('offers the recording and the analysis on a call that knows which call it was', async () => {
    getLeadStream.mockResolvedValue(stream({ items: [call('c1', { callId: 'sc-1' })] }));
    renderStream();

    const toggle = await screen.findByTestId('stream-call-toggle-c1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  /**
   * A CALL row with no `callId` is the ORDINARY case, not a leftover. A rep who
   * dialled from their own handset and logged it by hand has produced a call
   * with no `SalesCall` behind it — there is nothing to play, today or ever —
   * and calls mirrored before the id was carried land here too. No backfill can
   * change either group. Both must read exactly as they always have, a line of
   * history, rather than as a player that will never load.
   */
  it('leaves a call with nothing behind it exactly as it is, with nothing to open', async () => {
    getLeadStream.mockResolvedValue(stream({ items: [call('old', { callId: null })] }));
    renderStream();

    // Anchor on the row itself first. Without it the absence below passes
    // instantly against a component that has not rendered anything yet.
    const row = await screen.findByTestId('stream-item-old');
    expect(row).toHaveTextContent('Sales call old');
    expect(within(row).queryByTestId('stream-call-toggle-old')).not.toBeInTheDocument();
    expect(getCallRecording).not.toHaveBeenCalled();
  });

  /**
   * A person with fifty calls must not fire fifty recording requests on open.
   * The panels are mounted on EXPAND, and this is the assertion that keeps it
   * that way - the pre-fix instinct (render the player on every call row and
   * let it 404) would put one request per row on the wire before the rep has
   * decided which call they care about.
   */
  it('fetches nothing until a row is opened', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          call('c1', { callId: 'sc-1' }),
          call('c2', { callId: 'sc-2' }),
          call('c3', { callId: 'sc-3' }),
        ],
      }),
    );
    renderStream();

    await screen.findByTestId('stream-call-toggle-c3');
    expect(getCallRecording).not.toHaveBeenCalled();
    expect(getCallAnalysis).not.toHaveBeenCalled();
  });

  it('opens ONE call and fetches only that one', async () => {
    getLeadStream.mockResolvedValue(
      stream({ items: [call('c1', { callId: 'sc-1' }), call('c2', { callId: 'sc-2' })] }),
    );
    renderStream();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('stream-call-toggle-c1'));

    const detail = await screen.findByTestId('stream-call-detail-c1');
    await waitFor(() => expect(detail.querySelector('audio')).not.toBeNull());
    expect(detail.querySelector('audio')).toHaveAttribute('src', 'https://cdn.test/rec.mp3');

    // Per-record state, keyed: opening one row may not open its neighbour.
    expect(screen.queryByTestId('stream-call-detail-c2')).not.toBeInTheDocument();
    expect(getCallRecording.mock.calls.map((c) => c[0])).toEqual(['sc-1']);
    await waitFor(() => expect(getCallAnalysis.mock.calls.map((c) => c[0])).toEqual(['sc-1']));
  });

  it('closes again, so an opened call is not a one-way door', async () => {
    getLeadStream.mockResolvedValue(stream({ items: [call('c1', { callId: 'sc-1' })] }));
    renderStream();

    const user = userEvent.setup();
    const toggle = await screen.findByTestId('stream-call-toggle-c1');
    await user.click(toggle);
    await screen.findByTestId('stream-call-detail-c1');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.queryByTestId('stream-call-detail-c1')).not.toBeInTheDocument(),
    );
  });

  /**
   * The repo's central rule, inside the stream. "This call has no recording"
   * and "we could not find out" are opposite facts, and the second one used to
   * render as the first.
   */
  it('says a recording FAILED to load rather than showing an empty panel', async () => {
    getCallRecording.mockRejectedValue({ response: { status: 500 } });
    getLeadStream.mockResolvedValue(stream({ items: [call('c1', { callId: 'sc-1' })] }));
    renderStream();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('stream-call-toggle-c1'));

    const detail = await screen.findByTestId('stream-call-detail-c1');
    expect(await within(detail).findByRole('alert')).toHaveTextContent(
      'Recording could not be loaded',
    );
  });

  it('stays silent about a call that genuinely has no recording', async () => {
    getCallRecording.mockRejectedValue({ response: { status: 404 } });
    getLeadStream.mockResolvedValue(stream({ items: [call('c1', { callId: 'sc-1' })] }));
    renderStream();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('stream-call-toggle-c1'));

    const detail = await screen.findByTestId('stream-call-detail-c1');
    // Anchor: the analysis panel DID settle, so the absence below is a real
    // absence rather than a still-loading pane.
    await within(detail).findByText('A call recording is required to analyse');
    expect(within(detail).queryByRole('alert')).not.toBeInTheDocument();
    expect(detail.querySelector('audio')).toBeNull();
  });

  it('never puts a player on a message, a note or a status move', async () => {
    getLeadStream.mockResolvedValue(
      stream({
        items: [
          item({ kind: 'note', id: 'n1', at: '2026-08-30T09:00:00.000Z', title: 'Not' }),
          item({
            kind: 'status',
            id: 's1',
            at: '2026-08-30T09:01:00.000Z',
            title: 'NEW -> CONTACTED',
          }),
        ],
      }),
    );
    renderStream();

    await screen.findByTestId('stream-item-s1');
    expect(screen.queryByTestId('stream-call-toggle-n1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stream-call-toggle-s1')).not.toBeInTheDocument();
  });
});
