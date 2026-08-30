import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OpportunitiesPage from './OpportunitiesPage';

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
