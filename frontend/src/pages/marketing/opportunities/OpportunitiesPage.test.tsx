import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OpportunitiesPage from './OpportunitiesPage';
import { fmtSlot } from '../../../features/marketing/utils/format';

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

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: 'mgr-1', role: 'MANAGER' } }),
}));

const PIPELINES = [
  {
    id: 'p1',
    name: 'Sales Pipeline',
    isDefault: true,
    position: 0,
    archived: false,
    stages: [],
  },
];

const BOARD = {
  pipeline: { id: 'p1', name: 'Sales Pipeline', isDefault: true },
  stages: [
    {
      id: 's-new',
      pipelineId: 'p1',
      name: 'New',
      position: 0,
      probability: 10,
      isWon: false,
      isLost: false,
      opportunities: [
        {
          id: 'o1',
          pipelineId: 'p1',
          stageId: 's-new',
          name: 'Acme deal',
          value: 1000,
          currency: 'USD',
          status: 'OPEN',
        },
      ],
      totalValue: 1000,
      count: 1,
    },
  ],
};

/** One PersonCard, the shape `GET /opportunities/not-in-pipeline` returns. */
const personCard = (over: Record<string, unknown> = {}) => ({
  id: 'lead-1',
  name: 'Ayşe Yılmaz',
  businessName: 'Acme Kafe',
  contactPerson: 'Ayşe Yılmaz',
  phone: '+905551112233',
  status: 'CONTACTED',
  assignedToId: null,
  lastMessageAt: null,
  ...over,
});

/** A page of the "Hatta değil" column. `total` is the WHOLE column, every page. */
const column = (
  data: ReturnType<typeof personCard>[],
  meta: { total: number; page?: number; limit?: number; totalPages?: number },
) => ({
  data,
  meta: { page: 1, limit: 20, totalPages: 1, ...meta },
});

const emptyColumn = () => column([], { total: 0 });

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** Render the board at a specific URL, so the deep-link params are real. */
function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <OpportunitiesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OpportunitiesPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board') return Promise.resolve({ data: BOARD });
      if (url === '/opportunities/not-in-pipeline') return Promise.resolve({ data: emptyColumn() });
      return Promise.resolve({ data: {} });
    });
  });

  it('renders the board with the stage column and its deal card', async () => {
    render(<OpportunitiesPage />, { wrapper });

    expect(await screen.findByText('Opportunities')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument());
    expect(screen.getByText('Acme deal')).toBeInTheDocument();
    // The board fetched the default pipeline's board.
    expect(get).toHaveBeenCalledWith('/opportunities/board', expect.anything());
  });

  // A pipeline with deals in DIFFERENT currencies must not show an aggregate
  // total under one currency symbol — that implies a false conversion (€ + $
  // shown as one "$" figure). Mirror the forecast's guard: render a plain,
  // symbol-less number for a mixed-currency board. (Deal cards keep their own.)
  it('shows a symbol-less board total for a mixed-currency pipeline (no false conversion)', async () => {
    const MIXED_BOARD = {
      pipeline: { id: 'p1', name: 'Sales Pipeline', isDefault: true },
      stages: [
        {
          id: 's-new', pipelineId: 'p1', name: 'New', position: 0, probability: 10, isWon: false, isLost: false,
          opportunities: [
            { id: 'o1', pipelineId: 'p1', stageId: 's-new', name: 'USD deal', value: 1000, currency: 'USD', status: 'OPEN' },
            { id: 'o2', pipelineId: 'p1', stageId: 's-new', name: 'EUR deal', value: 2000, currency: 'EUR', status: 'OPEN' },
          ],
          totalValue: 3000, count: 2,
        },
      ],
    };
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board') return Promise.resolve({ data: MIXED_BOARD });
      if (url === '/opportunities/not-in-pipeline') return Promise.resolve({ data: emptyColumn() });
      return Promise.resolve({ data: {} });
    });

    render(<OpportunitiesPage />, { wrapper });
    await screen.findByText('USD deal');

    const total = screen.getByText(/Open total:/);
    expect(total.textContent).toMatch(/3[.,]000/); // the summed figure
    expect(total.textContent).not.toMatch(/[$€₺]/); // …but no currency symbol
  });
});

// The lead detail page's Satış tab is the second entrance to this board: its
// empty state deep-links here to CREATE a deal for one contact, and each of its
// rows deep-links here to OPEN one. Neither is a new creation or detail path —
// both reuse the dialog this page already owns — but both carry a parameter
// this page previously ignored, which is exactly the shape that fails silently.
describe('OpportunitiesPage — lead deep links', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board') return Promise.resolve({ data: BOARD });
      if (url === '/opportunities/o1')
        return Promise.resolve({ data: BOARD.stages[0].opportunities[0] });
      if (url === '/opportunities/not-in-pipeline') return Promise.resolve({ data: emptyColumn() });
      return Promise.resolve({ data: {} });
    });
  });

  // Without this the deal is created floating free of the contact who prompted
  // it — the board looks right, the lead record stays empty, and the Satış tab
  // that sent the user here still says "no deal for this contact".
  it('attaches ?leadId to a deal created through ?create=1', async () => {
    const user = userEvent.setup();
    renderAt('/opportunities?create=1&leadId=lead-7');

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText(/Acme Corp/), 'Hasan Usta');
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/opportunities',
        expect.objectContaining({ name: 'Hasan Usta', leadId: 'lead-7' }),
      ),
    );
  });

  // A plain "New deal" must NOT pick up a lead. The control that proves the
  // assertion above is about the parameter and not about the payload always
  // carrying a lead.
  it('does not attach a lead to a deal created without the param', async () => {
    const user = userEvent.setup();
    renderAt('/opportunities?create=1');

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText(/Acme Corp/), 'Serbest fırsat');
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual(expect.objectContaining({ leadId: undefined }));
  });

  // `?leadId` is read at OPEN time, not at save time, and this is what says so.
  // The param survives in the URL after useCreateParam strips only `create` —
  // so a save-time read would attach that lead to every subsequent deal created
  // on this board, silently filing other people's deals against one contact.
  it('does not carry the lead into the NEXT deal created on the board', async () => {
    const user = userEvent.setup();
    renderAt('/opportunities?create=1&leadId=lead-7');

    // First deal: from the deep link, so it belongs to the lead.
    const first = await screen.findByRole('dialog');
    await user.type(within(first).getByPlaceholderText(/Acme Corp/), 'Hasan Usta');
    await user.click(within(first).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // Second deal: opened from the board's own button, with `leadId` still in
    // the URL. It belongs to nobody.
    await user.click(screen.getByRole('button', { name: /new deal/i }));
    const second = await screen.findByRole('dialog');
    await user.type(within(second).getByPlaceholderText(/Acme Corp/), 'Başka fırsat');
    await user.click(within(second).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0][1]).toEqual(expect.objectContaining({ leadId: 'lead-7' }));
    expect(post.mock.calls[1][1]).toEqual(expect.objectContaining({ leadId: undefined }));
  });

  // Resolved by id rather than by scanning the board: the board is OPEN-only
  // and one pipeline at a time, so a WON deal — or any deal outside the default
  // pipeline — would simply not be there, and the link would open a board that
  // silently does not contain the deal it named.
  it('opens the named deal from ?deal=, without depending on it being on the board', async () => {
    renderAt('/opportunities?deal=o1&pipelineId=p1');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('Acme deal')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/opportunities/o1');
  });
});

/**
 * The board renders PEOPLE. Daily work runs from the human; the board stands
 * for forecast and overview — and the leftmost column is the 361 people nobody
 * is selling to, who appeared on no screen at all before this.
 */
describe('OpportunitiesPage — the board is a view of person-cards', () => {
  const AYSE = personCard();

  /** Two open stages and a terminal one, so a drop on Won can be refused. */
  const stage = (over: Record<string, unknown>) => ({
    pipelineId: 'p1',
    probability: 10,
    isWon: false,
    isLost: false,
    opportunities: [],
    totalValue: 0,
    count: 0,
    ...over,
  });

  const PEOPLE_BOARD = {
    pipeline: { id: 'p1', name: 'Sales Pipeline', isDefault: true },
    stages: [
      stage({
        id: 's-new',
        name: 'New',
        position: 0,
        opportunities: [
          {
            id: 'o1',
            pipelineId: 'p1',
            stageId: 's-new',
            leadId: 'lead-1',
            name: 'Happy Day Organizasyon',
            value: 45000,
            currency: 'TRY',
            status: 'OPEN',
            lead: AYSE,
          },
        ],
        totalValue: 45000,
        count: 1,
      }),
      stage({ id: 's-offer', name: 'Offer sent', position: 1, probability: 40 }),
      stage({ id: 's-won', name: 'Won', position: 2, probability: 100, isWon: true }),
    ],
  };

  const serve = (over: { board?: unknown; notInPipeline?: (page: number) => unknown } = {}) => {
    get.mockImplementation((url: string, cfg?: { params?: { page?: number } }) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board')
        return Promise.resolve({ data: over.board ?? PEOPLE_BOARD });
      if (url === '/opportunities/not-in-pipeline')
        return Promise.resolve({
          data: over.notInPipeline
            ? over.notInPipeline(cfg?.params?.page ?? 1)
            : column([personCard({ id: 'lead-9', name: 'Sessiz Kişi' })], { total: 1 }),
        });
      return Promise.resolve({ data: {} });
    });
  };

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    toastError.mockReset();
    serve();
  });

  it('puts the PERSON on the card, with the deal value under them', async () => {
    render(<OpportunitiesPage />, { wrapper });

    const card = await screen.findByTestId('deal-card-o1');
    expect(within(card).getByTestId('deal-card-person-o1')).toHaveTextContent('Ayşe Yılmaz');
    // The deal is still identifiable — a person may have more than one — but it
    // is no longer the headline.
    expect(card).toHaveTextContent('Happy Day Organizasyon');
    expect(card).toHaveTextContent(/45[.,]000/);
  });

  // `Opportunity.leadId` has no foreign key, so a deal can name a deleted
  // person or a neighbour's. Hiding those cards would quietly shrink the board
  // and the forecast would stop matching what is on it.
  it('renders a deal attached to nobody honestly rather than hiding it', async () => {
    serve({
      board: {
        pipeline: PEOPLE_BOARD.pipeline,
        stages: [
          stage({
            id: 's-new',
            name: 'New',
            position: 0,
            opportunities: [
              {
                id: 'o1',
                pipelineId: 'p1',
                stageId: 's-new',
                leadId: null,
                name: 'Happy Day Organizasyon',
                value: 45000,
                currency: 'TRY',
                status: 'OPEN',
                lead: null,
              },
            ],
            totalValue: 45000,
            count: 1,
          }),
        ],
      },
    });
    render(<OpportunitiesPage />, { wrapper });

    const card = await screen.findByTestId('deal-card-o1');
    expect(card).toHaveTextContent('Happy Day Organizasyon');
    expect(within(card).getByTestId('deal-card-nobody-o1')).toBeInTheDocument();
  });

  it('makes "Hatta değil" the leftmost column and counts the WHOLE column, not the page', async () => {
    serve({
      notInPipeline: () =>
        column(
          Array.from({ length: 20 }, (_, i) => personCard({ id: `lead-${i}`, name: `Kişi ${i}` })),
          { total: 361, totalPages: 19 },
        ),
    });
    render(<OpportunitiesPage />, { wrapper });

    const outside = await screen.findByTestId('column-not-in-pipeline');
    // Leftmost: the first column in the board's own row.
    expect(screen.getByTestId('board-columns').firstElementChild).toBe(outside);
    // 361 is the column; 20 is the screenful. The header says the column.
    expect(within(outside).getByTestId('not-in-pipeline-count')).toHaveTextContent('361');
    expect(within(outside).getAllByTestId(/^person-card-/)).toHaveLength(20);
  });

  it('brings the rest of the column only when asked, and appends it', async () => {
    const user = userEvent.setup();
    serve({
      notInPipeline: (page) =>
        column([personCard({ id: `lead-p${page}`, name: `Sayfa ${page}` })], {
          total: 361,
          page,
          limit: 1,
          totalPages: 361,
        }),
    });
    render(<OpportunitiesPage />, { wrapper });

    expect(await screen.findByText('Sayfa 1')).toBeInTheDocument();
    expect(screen.queryByText('Sayfa 2')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Daha fazla' }));

    // Appended, not replaced: dragging person #21 out must not require walking
    // back to the page they were on.
    expect(await screen.findByText('Sayfa 2')).toBeInTheDocument();
    expect(screen.getByText('Sayfa 1')).toBeInTheDocument();
  });

  // The repo's central rule. A column that cannot be read must never wear the
  // face of a column with nobody in it — the whole reason it exists is to say
  // how many people are outside the pipeline.
  it('says the column could not be read rather than showing it empty', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board') return Promise.resolve({ data: PEOPLE_BOARD });
      if (url === '/opportunities/not-in-pipeline') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: {} });
    });
    render(<OpportunitiesPage />, { wrapper });

    // Positive anchor first — the two absences below would pass instantly
    // against the loading state.
    expect(await screen.findByText('Hatta olmayanlar okunamadı.')).toBeInTheDocument();
    const outside = screen.getByTestId('column-not-in-pipeline');
    expect(within(outside).queryByTestId('not-in-pipeline-count')).not.toBeInTheDocument();
    expect(within(outside).queryByTestId('not-in-pipeline-empty')).not.toBeInTheDocument();
  });

  it('says the column is empty only once it has actually been read', async () => {
    serve({ notInPipeline: () => column([], { total: 0 }) });
    render(<OpportunitiesPage />, { wrapper });

    expect(await screen.findByTestId('not-in-pipeline-empty')).toBeInTheDocument();
    expect(screen.getByTestId('not-in-pipeline-count')).toHaveTextContent('0');
  });

  /**
   * The card the design asked for, in full: "kişinin adı birincil, anlaşma
   * değeri ve SON TEMASI ikincil" (2026-08-30 §1). The name and the value
   * landed; the last contact was computed server-side — two extra raw
   * aggregates per board load and per column page — and drawn nowhere.
   *
   * It is the third thing a card needs to be a decision rather than a label: a
   * name and a number say who and how much, and only this says whether anyone
   * has actually spoken to them.
   */
  describe('the card says when they were last spoken to', () => {
    // Local wall-clock rather than a fixed ISO instant, so the expectation does
    // not move with the machine's timezone.
    const AUG_29_0905 = new Date(2026, 7, 29, 9, 5).toISOString();

    it("carries the person's last contact on the deal card", async () => {
      serve({
        board: {
          pipeline: PEOPLE_BOARD.pipeline,
          stages: [
            stage({
              id: 's-new',
              name: 'New',
              position: 0,
              opportunities: [
                {
                  id: 'o1',
                  pipelineId: 'p1',
                  stageId: 's-new',
                  leadId: 'lead-1',
                  name: 'Happy Day Organizasyon',
                  value: 45000,
                  currency: 'TRY',
                  status: 'OPEN',
                  lead: personCard({ lastMessageAt: AUG_29_0905 }),
                },
              ],
              totalValue: 45000,
              count: 1,
            }),
          ],
        },
      });
      render(<OpportunitiesPage />, { wrapper });

      const card = await screen.findByTestId('deal-card-o1');
      const line = within(card).getByTestId('deal-contact-o1');
      // The surface's own short-date helper, not a second formatter: a board is
      // a COLUMN of these, so the year and the seconds are noise on every row.
      expect(line).toHaveTextContent(`Son temas: ${fmtSlot(AUG_29_0905)}`);
      expect(line.textContent).not.toContain(AUG_29_0905); // never the raw instant
    });

    it('carries it on the "Hatta değil" cards too, where it decides the most', async () => {
      serve({
        notInPipeline: () =>
          column([personCard({ id: 'lead-9', name: 'Sessiz Kişi', lastMessageAt: AUG_29_0905 })], {
            total: 1,
          }),
      });
      render(<OpportunitiesPage />, { wrapper });

      const card = await screen.findByTestId('person-card-lead-9');
      expect(within(card).getByTestId('person-contact-lead-9')).toHaveTextContent(
        `Son temas: ${fmtSlot(AUG_29_0905)}`,
      );
    });

    // This column is the 361 people nobody is selling to, and most of them have
    // never been messaged at all. Silence is the ANSWER here, so it gets words:
    // an empty slot reads as "not loaded yet", and any date standing in for
    // "never" is simply false.
    it('says the silence out loud rather than leaving the slot blank', async () => {
      serve({
        notInPipeline: () =>
          column([personCard({ id: 'lead-9', name: 'Sessiz Kişi', lastMessageAt: null })], {
            total: 1,
          }),
      });
      render(<OpportunitiesPage />, { wrapper });

      // Positive anchor first — the absence below would pass against a card
      // that never rendered at all.
      const card = await screen.findByTestId('person-card-lead-9');
      const line = within(card).getByTestId('person-contact-lead-9');
      expect(line).toHaveTextContent('Henüz temas yok');
      expect(line.textContent).not.toMatch(/\d/); // no date stood in for "never"
    });
  });

  it('opens a deal for a person dragged onto a stage, with no name of its own', async () => {
    render(<OpportunitiesPage />, { wrapper });

    const person = await screen.findByTestId('person-card-lead-9');
    fireEvent.dragStart(person);
    const target = screen.getByTestId('column-s-offer');
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/opportunities', {
        leadId: 'lead-9',
        pipelineId: 'p1',
        stageId: 's-offer',
      }),
    );
  });

  // Creating a deal directly in a terminal stage resolves it WON/LOST on the
  // backend, so it would vanish from this OPEN-only board while silently
  // entering won/lost reporting. The "+ Add" button already refuses this; the
  // drag has to refuse it too, out loud.
  it('refuses to open a deal by dropping a person straight on Won', async () => {
    render(<OpportunitiesPage />, { wrapper });

    const person = await screen.findByTestId('person-card-lead-9');
    fireEvent.dragStart(person);
    const won = screen.getByTestId('column-s-won');
    fireEvent.dragOver(won);
    fireEvent.drop(won);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  // The gesture that already existed. A drag state that stopped telling deals
  // and people apart would break this one silently.
  it('still moves an existing deal between stages', async () => {
    render(<OpportunitiesPage />, { wrapper });

    const card = await screen.findByTestId('deal-card-o1');
    fireEvent.dragStart(card);
    const target = screen.getByTestId('column-s-offer');
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/opportunities/o1/move', {
        stageId: 's-offer',
        position: undefined,
      }),
    );
  });

  // The column is where people go OUT of; nothing is dropped back into it.
  // Dropping a deal there must not read as a move to an unknown stage.
  it('treats the "Hatta değil" column as a source, never a destination', async () => {
    render(<OpportunitiesPage />, { wrapper });

    const card = await screen.findByTestId('deal-card-o1');
    fireEvent.dragStart(card);
    const outside = screen.getByTestId('column-not-in-pipeline');
    fireEvent.dragOver(outside);
    fireEvent.drop(outside);

    // Anchor on something that DID render, so "no request" is settled rather
    // than a race with the first paint.
    await screen.findByTestId('person-card-lead-9');
    expect(post).not.toHaveBeenCalled();
  });
});


/**
 * The board as the person surface's **Hat** view.
 *
 * Stage 2 of the one-screen brief: the left column of `/inbox` switches between
 * four arrangements of the same people, and this is one of them. The rule the
 * brief is hardest about is "hiçbir özelliği kaybetmeden" — the kanban arrives
 * whole, with drag-between-stages and the "Hatta değil" column, or it does not
 * arrive. So these tests assert the CAPABILITIES survive the chrome swap, not
 * that a smaller board renders.
 *
 * `embedded` is the same prop LeadsPage, ChannelsSettingsPage, SnippetsPage,
 * OffersTab and TasksTab already take, and it means the same thing here: the
 * page chrome (its own <h1>, its header actions) is replaced by the host's, and
 * NOTHING else changes. The list, the dialogs and the mutations are one copy.
 */
describe('OpportunitiesPage — embedded as the surface Hat view', () => {
  const stage = (over: Record<string, unknown>) => ({
    pipelineId: 'p1',
    probability: 10,
    isWon: false,
    isLost: false,
    opportunities: [],
    totalValue: 0,
    count: 0,
    ...over,
  });

  const AYSE = personCard({ id: 'lead-1', name: 'Ayşe Yılmaz' });

  const BOARD_WITH_LEAD = {
    pipeline: { id: 'p1', name: 'Sales Pipeline', isDefault: true },
    stages: [
      stage({
        id: 's-new',
        name: 'New',
        position: 0,
        opportunities: [
          {
            id: 'o1',
            pipelineId: 'p1',
            stageId: 's-new',
            leadId: 'lead-1',
            name: 'Happy Day Organizasyon',
            value: 45000,
            currency: 'TRY',
            status: 'OPEN',
            lead: AYSE,
          },
        ],
        totalValue: 45000,
        count: 1,
      }),
      stage({ id: 's-offer', name: 'Offer sent', position: 1, probability: 40 }),
    ],
  };

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    toastError.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board') return Promise.resolve({ data: BOARD_WITH_LEAD });
      if (url === '/opportunities/not-in-pipeline')
        return Promise.resolve({
          data: column([personCard({ id: 'lead-9', name: 'Sessiz Kişi' })], { total: 1 }),
        });
      return Promise.resolve({ data: {} });
    });
  });

  const renderEmbedded = (props: Record<string, unknown> = {}) =>
    render(<OpportunitiesPage embedded {...props} />, { wrapper });

  it('drops its own page chrome and keeps the board', async () => {
    renderEmbedded();

    // Positive anchor first: the board is up. The absence below would pass just
    // as well against a component that rendered nothing at all.
    expect(await screen.findByTestId('board-columns')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('still carries the "Hatta değil" column — the biggest one on the board', async () => {
    renderEmbedded();

    const outside = await screen.findByTestId('column-not-in-pipeline');
    expect(within(outside).getByTestId('not-in-pipeline-count')).toHaveTextContent('1');
    expect(within(outside).getByTestId('person-card-lead-9')).toBeInTheDocument();
  });

  it('still moves a deal between stages by drag', async () => {
    renderEmbedded();

    const card = await screen.findByTestId('deal-card-o1');
    fireEvent.dragStart(card);
    const target = screen.getByTestId('column-s-offer');
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/opportunities/o1/move', {
        stageId: 's-offer',
        position: undefined,
      }),
    );
  });

  it('still opens a deal for a person dragged out of "Hatta değil"', async () => {
    renderEmbedded();

    const person = await screen.findByTestId('person-card-lead-9');
    fireEvent.dragStart(person);
    const target = screen.getByTestId('column-s-offer');
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/opportunities', {
        leadId: 'lead-9',
        pipelineId: 'p1',
        stageId: 's-offer',
      }),
    );
  });

  /**
   * The point of the view, in the owner's own words: "hattan birine tıklayıp
   * aynı ekranda yazışmasını okursun". A click on this board REPORTS a person
   * to the host, which opens their stream and record card beside it. It does
   * not navigate — the surface's one rule.
   */
  it('reports the person behind a deal card up to the surface', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    renderEmbedded({ onSelectPerson });

    await user.click(await screen.findByTestId('deal-card-o1'));

    expect(onSelectPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'lead-1' }));
  });

  it('reports a person in "Hatta değil" up too — they are the ones with no deal to click', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    renderEmbedded({ onSelectPerson });

    await user.click(await screen.findByTestId('person-card-lead-9'));

    expect(onSelectPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'lead-9' }));
  });

  /**
   * Selecting takes the CARD's click, so the edit dialog needs its own door or
   * it is a feature this view lost: Kazanıldı / Kaybedildi / Sil / value /
   * notes / close date live nowhere else. The record card's SATIŞ section moves
   * a stage and adds a deal; it cannot close or delete one.
   */
  it('keeps the deal dialog reachable, on its own control', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    renderEmbedded({ onSelectPerson });

    await user.click(await screen.findByTestId('deal-edit-o1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('Happy Day Organizasyon')).toBeInTheDocument();
    // Editing a deal is not selecting a person; the card's click must not also
    // have fired.
    expect(onSelectPerson).not.toHaveBeenCalled();
  });

  /**
   * A keyboard reaches the same people a mouse does — from EVERY column.
   *
   * The "Hatta değil" cards took `role="button"`, a tab stop and Enter/Space
   * when the surface started listening; the deal cards took `onClick` and
   * `aria-current` and nothing else. So a keyboard user could select a person
   * out of the one column that is only a SOURCE — nothing is ever dropped back
   * into "Hatta değil" — and out of none of the seven stages beside it. The
   * board was mouse-only for the half of it that carries the deals.
   *
   * Enter AND Space, because a `role="button"` promises both, and `preventDefault`
   * on Space or the page scrolls under the user instead.
   */
  it.each([
    ['{Enter}', 'Enter'],
    [' ', 'Space'],
  ])('selects the person behind a deal card from the keyboard (%s)', async (key) => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    renderEmbedded({ onSelectPerson });

    const card = await screen.findByTestId('deal-card-o1');
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');

    card.focus();
    expect(card).toHaveFocus();
    await user.keyboard(key);

    expect(onSelectPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'lead-1' }));
  });

  /**
   * The edit control is a real `<button>`, so it must not be INSIDE the card's
   * `role="button"` — a nested interactive is flattened by screen readers and
   * the pencil stops being announced as its own thing. It sits over the card
   * as a sibling instead, which is also why it no longer needs to stop the
   * card's click from propagating: a sibling's click was never the card's.
   */
  it('keeps the edit control out of the card, so neither swallows the other', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    renderEmbedded({ onSelectPerson });

    const card = await screen.findByTestId('deal-card-o1');
    const edit = screen.getByTestId('deal-edit-o1');
    expect(card.contains(edit)).toBe(false);

    await user.click(edit);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(onSelectPerson).not.toHaveBeenCalled();
  });

  it('marks the person the surface has open, so a view switch is visible', async () => {
    renderEmbedded({ onSelectPerson: vi.fn(), selectedLeadId: 'lead-1' });

    const card = await screen.findByTestId('deal-card-o1');
    expect(card).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('person-card-lead-9')).toHaveAttribute('aria-current', 'false');
  });

  /**
   * The control. `/opportunities` is untouched by all of the above: a click on
   * a deal card there opens the dialog, exactly as it always has, because that
   * page has no person surface to report to.
   */
  it('leaves the standalone board alone — a card click still opens the dialog', async () => {
    const user = userEvent.setup();
    render(<OpportunitiesPage />, { wrapper });

    await user.click(await screen.findByTestId('deal-card-o1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('Happy Day Organizasyon')).toBeInTheDocument();
  });

  /**
   * `?create=1` belongs to whichever page OWNS the URL. Embedded, this board is
   * a column on somebody else's page, and two embeddable views cannot both
   * claim one parameter. It is honoured on `/opportunities` and ignored here.
   */
  it('does not claim the host page\'s ?create=1', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/inbox?left=board&create=1']}>
          <OpportunitiesPage embedded />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByTestId('board-columns');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
