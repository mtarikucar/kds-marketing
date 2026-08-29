import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
