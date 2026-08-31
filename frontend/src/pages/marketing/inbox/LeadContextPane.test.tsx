import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LeadContextPane } from './LeadContextPane';
import type { Lead } from '../../../features/marketing/types';

// The card carries a SATIŞ section now, which reads and writes. Mocked at the
// axios layer rather than at the service layer, so the URLs and payloads the
// card actually sends are the ones under test.
const get = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
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
    businessName: 'Acme Kafe',
    contactPerson: 'Ayşe Yılmaz',
    phone: '+905551112233',
    email: 'ayse@acme.test',
    city: 'Ankara',
    businessType: 'CAFE',
    source: 'WEBSITE',
    status: 'CONTACTED',
    priority: 'HIGH',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...over,
  }) as Lead;

const PIPELINES = [
  {
    id: 'p1',
    name: 'Satış Hattı',
    isDefault: true,
    position: 0,
    archived: false,
    stages: [
      { id: 's-new', pipelineId: 'p1', name: 'Yeni', position: 0, probability: 10, isWon: false, isLost: false },
      { id: 's-offer', pipelineId: 'p1', name: 'Teklif gönderildi', position: 1, probability: 40, isWon: false, isLost: false },
    ],
  },
];

/** One OPEN deal, forever at 's-new' on the server — the truth the card owes. */
const DEAL = {
  id: 'o1',
  pipelineId: 'p1',
  stageId: 's-new',
  leadId: 'p1',
  assignedToId: null,
  name: 'Happy Day Organizasyon',
  value: 45000,
  currency: 'TRY',
  status: 'OPEN',
  source: null,
  notes: null,
  position: 0,
  lostReason: null,
  expectedCloseDate: null,
  wonAt: null,
  lostAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({ data: {} });
  get.mockImplementation((url: string) => {
    if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
    if (url === '/opportunities')
      return Promise.resolve({
        data: { data: [DEAL], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } },
      });
    return Promise.resolve({ data: {} });
  });
});

/** One QueryClient per render, so no test inherits another's cache. */
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

const renderCard = (props: Partial<React.ComponentProps<typeof LeadContextPane>> = {}) =>
  render(wrap(<LeadContextPane lead={person()} {...props} />));

describe('LeadContextPane — the record card', () => {
  it('says who this is, how to reach them and where they stand', () => {
    renderCard();

    const card = screen.getByTestId('record-card');
    expect(card).toHaveTextContent('Ayşe Yılmaz');
    expect(card).toHaveTextContent('Acme Kafe');
    expect(card).toHaveTextContent('+905551112233');
    expect(card).toHaveTextContent('ayse@acme.test');
    expect(card).toHaveTextContent('CONTACTED');
  });

  it('names the owner, and says so when there is not one', () => {
    renderCard({
      lead: person({
        assignedTo: { id: 'u1', firstName: 'Mehmet', lastName: 'Kaya' } as Lead['assignedTo'],
      }),
    });
    expect(screen.getByTestId('record-owner')).toHaveTextContent('Mehmet Kaya');

    // Unowned is a fact worth reading, not a blank line — it is the whole
    // point of the Atanmamış queue one column over.
    renderCard({ lead: person({ assignedTo: undefined }) });
    expect(screen.getAllByTestId('record-owner')[1]).toHaveTextContent('Atanmamış');
  });

  // The surface's ONE navigation. Everything else on the page is a selection;
  // deep work happens on the four-tab lead detail.
  it('offers exactly one way off the surface, into this person’s detail', () => {
    renderCard();

    const card = screen.getByTestId('record-card');
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/leads/p1');
  });

  it('says nobody is selected rather than rendering an empty card', () => {
    renderCard({ lead: null });

    expect(screen.getByTestId('record-card-idle')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // The deal is a FIELD of the person now, not a place you navigate to.
  it('carries the SATIŞ section for the selected person, and asks for THEIR deals', async () => {
    renderCard();

    expect(await screen.findByTestId('record-sales')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/opportunities', { params: { leadId: 'p1' } });
  });

  it('does not go looking for deals when nobody is selected', async () => {
    renderCard({ lead: null });

    // Positive anchor: the idle card has rendered, so "no request" is a
    // settled fact rather than a race with the first paint.
    expect(screen.getByTestId('record-card-idle')).toBeInTheDocument();
    await waitFor(() => expect(get).not.toHaveBeenCalledWith('/opportunities', expect.anything()));
  });

  // Below lg the three columns cannot coexist, so the card arrives as a sheet.
  // It has to be dismissible or it traps the person who opened it.
  it('closes when the sheet is dismissed', async () => {
    const onClose = vi.fn();
    render(wrap(<LeadContextPane lead={person()} asSheet onClose={onClose} />));

    screen.getByRole('button', { name: 'Kapat' }).click();
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * The card is rendered ONCE by the surface and handed a different person as the
 * selection changes — it is not remounted by the router, because selecting is
 * not navigating. So every piece of per-person state inside it has to be reset
 * by something, and that something is `key`.
 *
 * This branch's lineage has already shipped the other outcome: a header that
 * kept lead A's phone number and dialled it under lead B's id. The stage
 * selector is the same shape of state — an optimistic value that outlives the
 * person it was set for is a control claiming a move that never happened.
 */
describe('LeadContextPane — per-person state is keyed, not carried', () => {
  it('drops a stage move that never landed when the selection changes and comes back', async () => {
    const user = userEvent.setup();
    // The move is issued and never answers: the optimistic value is live and
    // the server still says 's-new'. Exactly the window the bug lives in.
    post.mockImplementation((url: string) =>
      url.endsWith('/move') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );

    const other = person({ id: 'p2', contactPerson: 'Başka Kişi' });
    const { rerender } = render(wrap(<LeadContextPane lead={person()} />));

    await screen.findByText('Happy Day Organizasyon');
    await user.click(screen.getByTestId('deal-stage-o1'));
    await user.click(await screen.findByRole('option', { name: 'Teklif gönderildi' }));
    // The optimistic value is showing — this is the state that must not survive.
    await waitFor(() =>
      expect(screen.getByTestId('deal-stage-o1')).toHaveTextContent('Teklif gönderildi'),
    );

    rerender(wrap(<LeadContextPane lead={other} />));
    await screen.findByText('Başka Kişi');
    rerender(wrap(<LeadContextPane lead={person()} />));

    // Back on the first person, the control must read what the SERVER says the
    // deal's stage is — not the move that is still in the air.
    const stage = await screen.findByTestId('deal-stage-o1');
    expect(stage).toHaveTextContent('Yeni');
    expect(stage).not.toHaveTextContent('Teklif gönderildi');
  });
});
