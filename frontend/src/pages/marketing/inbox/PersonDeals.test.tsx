import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonDeals } from './PersonDeals';

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
    i18n: { language: 'tr' },
  }),
}));

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
      { id: 's-won', pipelineId: 'p1', name: 'Kazanıldı', position: 2, probability: 100, isWon: true, isLost: false },
    ],
  },
];

const deal = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  pipelineId: 'p1',
  stageId: 's-new',
  leadId: 'lead-1',
  assignedToId: null,
  name: 'Happy Day Organizasyon',
  value: 45000,
  currency: 'TRY',
  status: 'OPEN',
  source: null,
  notes: null,
  position: 0,
  lostReason: null,
  expectedCloseDate: '2026-09-15T00:00:00.000Z',
  wonAt: null,
  lostAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

/** Serve these deals for the person, and the pipeline that names their stages. */
function serve(deals: ReturnType<typeof deal>[]) {
  get.mockImplementation((url: string) => {
    if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
    if (url === '/opportunities')
      return Promise.resolve({
        data: { data: deals, meta: { total: deals.length, page: 1, limit: 20, totalPages: 1 } },
      });
    return Promise.resolve({ data: {} });
  });
}

function renderDeals(leadId = 'lead-1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PersonDeals leadId={leadId} />
    </QueryClientProvider>,
  );
}

describe('PersonDeals — the SATIŞ section of the record card', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    toastError.mockReset();
    post.mockResolvedValue({ data: {} });
    serve([deal()]);
  });

  it('reads this person’s deals — name, value, expected close — and nobody else’s', async () => {
    renderDeals();

    expect(await screen.findByText('Happy Day Organizasyon')).toBeInTheDocument();
    expect(screen.getByTestId('record-sales')).toHaveTextContent(/45[.,]000/);
    // The expected close date, in the LOCALE the page renders in rather than as
    // an ISO string (fmtDate threads i18next.language, which defaults to tr).
    expect(screen.getByTestId('deal-close-o1')).toHaveTextContent(
      new Date('2026-09-15T00:00:00.000Z').toLocaleDateString('tr'),
    );
    // `leadId` is the whole correctness of the request: drop it and the card
    // shows the WORKSPACE's deals under one person's name.
    expect(get).toHaveBeenCalledWith('/opportunities', { params: { leadId: 'lead-1' } });
  });

  // The point of the whole section: the stage moves from HERE. No navigation,
  // same spirit as every other control on the person surface.
  it('moves the deal when the stage selector is used', async () => {
    const user = userEvent.setup();
    renderDeals();

    await screen.findByText('Happy Day Organizasyon');
    const stage = screen.getByTestId('deal-stage-o1');
    expect(stage).toHaveTextContent('Yeni');

    await user.click(stage);
    await user.click(await screen.findByRole('option', { name: 'Teklif gönderildi' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/opportunities/o1/move', {
        stageId: 's-offer',
        position: undefined,
      }),
    );
  });

  // A control left showing a stage the deal is not in is a lie the rep acts on.
  it('puts the selector back and says why when the move fails', async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      response: { data: { message: 'Aşama bu hatta ait değil' } },
    });
    renderDeals();

    await screen.findByText('Happy Day Organizasyon');
    const stage = screen.getByTestId('deal-stage-o1');
    expect(stage).toHaveTextContent('Yeni');

    await user.click(stage);
    await user.click(await screen.findByRole('option', { name: 'Teklif gönderildi' }));

    // Says why — the backend's own reason, not a generic shrug.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Aşama bu hatta ait değil'));
    // …and the control is back where the deal actually is.
    expect(screen.getByTestId('deal-stage-o1')).toHaveTextContent('Yeni');
    expect(screen.getByTestId('deal-stage-o1')).not.toHaveTextContent('Teklif gönderildi');
  });

  it('offers "Hatta ekle" for a person with no deal, and opens one with no invented name', async () => {
    const user = userEvent.setup();
    serve([]);
    renderDeals();

    const add = await screen.findByRole('button', { name: 'Hatta ekle' });
    await user.click(add);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/opportunities', { leadId: 'lead-1' }));
    // The person's own name is the deal's name, and the BACKEND supplies it —
    // a name invented here would be a second answer to "who is this".
    expect(post.mock.calls[0][1]).not.toHaveProperty('name');
  });

  // The board's leftmost column is "no OPEN deal". A card that called a person
  // with one WON deal "in the pipeline" would disagree with the column that
  // still lists them — two surfaces, two answers, one question.
  it('still offers "Hatta ekle" when every deal the person has is closed', async () => {
    serve([deal({ status: 'WON', stageId: 's-won' })]);
    renderDeals();

    // The closed deal is still shown — nothing is hidden.
    expect(await screen.findByText('Happy Day Organizasyon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hatta ekle' })).toBeInTheDocument();
  });

  it('renders every deal when the person has more than one', async () => {
    serve([deal(), deal({ id: 'o2', name: 'İkinci anlaşma', value: 9000, stageId: 's-offer' })]);
    renderDeals();

    expect(await screen.findByText('Happy Day Organizasyon')).toBeInTheDocument();
    expect(screen.getByText('İkinci anlaşma')).toBeInTheDocument();
    // Two deals, two independent stage selectors — neither borrowing the other's.
    expect(screen.getByTestId('deal-stage-o1')).toHaveTextContent('Yeni');
    expect(screen.getByTestId('deal-stage-o2')).toHaveTextContent('Teklif gönderildi');
  });

  // The repo's central rule: a failure must never wear the empty state's face.
  it('says the deals could not be read rather than showing a person with none', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      return Promise.reject(new Error('boom'));
    });
    renderDeals();

    // Positive anchor first: without it the two absence checks below pass
    // instantly against the loading state.
    expect(await screen.findByText('Fırsatlar yüklenemedi.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hatta ekle' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('deals-empty')).not.toBeInTheDocument();
  });

  // The pipelines read only NAMES the stages. Failing the section because a
  // label could not be resolved would hide real deals over a cosmetic gap.
  it('keeps showing the deal when the stage names cannot be read', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.reject(new Error('nope'));
      if (url === '/opportunities')
        return Promise.resolve({
          data: { data: [deal()], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } },
        });
      return Promise.resolve({ data: {} });
    });
    renderDeals();

    expect(await screen.findByText('Happy Day Organizasyon')).toBeInTheDocument();
    // "We could not name it" and "this deal has no stage" must not look alike.
    expect(screen.getByTestId('deal-stage-o1')).toHaveTextContent('Bilinmeyen aşama');
  });

  it('asks for the deals of whichever person it is given', async () => {
    renderDeals('lead-9');
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/opportunities', { params: { leadId: 'lead-9' } }),
    );
  });

  it('says so when opening a deal fails, instead of a section that silently did nothing', async () => {
    const user = userEvent.setup();
    serve([]);
    post.mockRejectedValue({ response: { data: { message: 'Hattın aşaması yok' } } });
    renderDeals();

    await user.click(await screen.findByRole('button', { name: 'Hatta ekle' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Hattın aşaması yok'));
  });

  it('names the deal’s own status, so a closed deal does not read as an open one', async () => {
    serve([deal({ status: 'WON', stageId: 's-won' })]);
    renderDeals();

    const row = await screen.findByTestId('deal-o1');
    expect(within(row).getByText('WON')).toBeInTheDocument();
  });
});
