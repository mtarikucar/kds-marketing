import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import LeadsPage from './LeadsPage';

const listLeads = vi.fn();
const bulkDeleteLeads = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  listLeads: (...a: unknown[]) => listLeads(...a),
  bulkAssignLeads: vi.fn(),
  bulkDeleteLeads: (...a: unknown[]) => bulkDeleteLeads(...a),
  bulkEnrollLeads: vi.fn(),
  exportLeadsCsv: vi.fn(),
}));

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: 'MANAGER', id: 'u-1' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const PAGE = {
  data: [
    {
      id: 'l1',
      businessName: 'Acme',
      businessType: 'OTHER',
      source: 'WEBSITE',
      city: 'Ankara',
      status: 'NEW',
      assignedTo: null,
      createdAt: '2026-06-01T00:00:00Z',
    },
  ],
  meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
};

describe('LeadsPage — server-side sorting', () => {
  beforeEach(() => {
    listLeads.mockReset();
    listLeads.mockResolvedValue(PAGE);
  });

  it('sends sortBy/sortOrder to the backend when a sortable column header is clicked', async () => {
    render(<LeadsPage />, { wrapper });
    await screen.findByText('Acme');
    expect(listLeads).toHaveBeenCalled();

    // Click the Business Name column header (a sortable column). With only
    // client-side sorting this reorders the visible page and never re-queries;
    // server-side sorting must re-call listLeads with the sort params so the
    // WHOLE dataset is ordered, not just the 20 visible rows.
    const header = screen.getByRole('button', { name: 'leads.table.business' });
    await userEvent.click(header);

    await waitFor(() => {
      const last = listLeads.mock.calls[listLeads.mock.calls.length - 1][0];
      expect(last.sortBy).toBe('businessName');
      expect(last.sortOrder).toBe('asc');
    });
  });
});

// Bulk delete is destructive and must be gated by the design-system
// ConfirmDialog (not window.confirm), firing only on the explicit confirm.
describe('LeadsPage — bulk delete confirmation', () => {
  beforeEach(() => {
    listLeads.mockReset();
    listLeads.mockResolvedValue(PAGE);
    bulkDeleteLeads.mockReset();
    bulkDeleteLeads.mockResolvedValue({ deleted: 1 });
  });

  it('opens a confirm dialog and only deletes after the destructive confirm', async () => {
    const user = userEvent.setup();
    render(<LeadsPage />, { wrapper });
    await screen.findByText('Acme');

    await user.click(screen.getByRole('checkbox', { name: 'Select row' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // The toolbar click opens the ConfirmDialog; nothing is deleted yet.
    expect(bulkDeleteLeads).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bulkDeleteLeads).toHaveBeenCalledWith(['l1']));
  });

  it('does not delete when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    render(<LeadsPage />, { wrapper });
    await screen.findByText('Acme');

    await user.click(screen.getByRole('checkbox', { name: 'Select row' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(bulkDeleteLeads).not.toHaveBeenCalled();
  });
});

/**
 * The work queue — spec §1's whole reason for a Kişiler tab.
 *
 * Three chips over one list: what nobody has answered, what nobody owns, and
 * everything. "Bekleyen" is deliberately NOT Lead.status='WAITING' (a stage a
 * rep chose on purpose) and not unreadCount (zeroed by merely opening a
 * thread) — it is the leads whose conversation the customer wrote last,
 * resolved by the backend's waitingReply filter.
 */
describe('LeadsPage — the work queue chips', () => {
  /** Route each call by the params it carries, so counts and list can differ. */
  const byParams = (spec: {
    all?: number | Error;
    unassigned?: number | Error;
    waiting?: number | Error;
    rows?: typeof PAGE.data;
  }) => {
    listLeads.mockImplementation((p: any) => {
      const which = p.waitingReply
        ? 'waiting'
        : p.assignmentStatus === 'unassigned'
        ? 'unassigned'
        : 'all';
      const total = spec[which as 'all'];
      if (total instanceof Error) return Promise.reject(total);
      const rows = spec.rows ?? PAGE.data;
      return Promise.resolve({
        data: p.limit === 1 ? [] : rows,
        meta: { total: total ?? 0, page: 1, limit: p.limit ?? 20, totalPages: 1 },
      });
    });
  };

  beforeEach(() => {
    listLeads.mockReset();
    byParams({ all: 365, unassigned: 41, waiting: 2 });
  });

  it('offers exactly the three queues, each with its count', async () => {
    render(<LeadsPage />, { wrapper });

    // Anchor on a chip that has its NUMBER, not merely its label. The chips
    // render before the counts land, so waiting on the label alone measures a
    // half-settled page — and would report every count as missing.
    await screen.findByRole('button', { name: 'Bekleyen 2' });

    const queue = screen.getByRole('group', { name: 'İş kuyruğu' });
    expect(
      within(queue)
        .getAllByRole('button')
        .map((b) => b.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Bekleyen 2', 'Atanmamış 41', 'Hepsi 365']);
  });

  it('asks the backend for the leads nobody has answered', async () => {
    const user = userEvent.setup();
    render(<LeadsPage />, { wrapper });
    await screen.findByText('Acme');

    await user.click(screen.getByRole('button', { name: /Bekleyen/ }));

    await waitFor(() => {
      const listCalls = listLeads.mock.calls.map((c) => c[0]).filter((p: any) => p.limit !== 1);
      const last = listCalls[listCalls.length - 1];
      expect(last.waitingReply).toBe(true);
      // Single-select: the queue owns both dimensions, so picking one does not
      // leave the previous one silently stacked underneath.
      expect(last.assignmentStatus).toBeUndefined();
    });
  });

  it('keeps /leads?assignmentStatus=unassigned resolving, and lights that chip', async () => {
    // The dashboard's triage deep link. It predates the chips and must keep
    // landing on the same filtered list.
    render(<LeadsPage />, {
      wrapper: ({ children }: { children: React.ReactNode }) => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/leads?assignmentStatus=unassigned']}>
              {children}
            </MemoryRouter>
          </QueryClientProvider>
        );
      },
    });

    await screen.findByText('Acme');
    expect(
      await screen.findByRole('button', { name: /Atanmamış/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(listLeads.mock.calls[0][0].assignmentStatus).toBe('unassigned');
  });

  it('reads the ACTIVE queue count off the list itself, so the two agree', async () => {
    // The chip promises "click me and you get this many rows". For the queue
    // you are already in, the list has already counted them — asking a second
    // time is one more thing that can disagree.
    byParams({ all: 365, unassigned: 41, waiting: 2 });
    render(<LeadsPage />, { wrapper });
    await screen.findByText('Acme');

    const probes = () =>
      listLeads.mock.calls.map((c) => c[0]).filter((p: any) => p.limit === 1);
    await waitFor(() => expect(probes().length).toBeGreaterThan(0));
    // 'all' is the opening queue, so only the other two are probed.
    expect(probes().some((p: any) => p.waitingReply)).toBe(true);
    expect(probes().some((p: any) => p.assignmentStatus === 'unassigned')).toBe(true);
    expect(
      probes().some((p: any) => !p.waitingReply && !p.assignmentStatus),
    ).toBe(false);
  });

  it('says a count is unknown rather than showing it as zero', async () => {
    // The rule this repo has already paid for: a failed query and "there is
    // nothing here" must not render the same. A chip reading "Bekleyen 0"
    // when the count request 500s says the queue is clear when nobody knows.
    byParams({ all: 365, unassigned: 41, waiting: new Error('boom') });
    render(<LeadsPage />, { wrapper });

    const waiting = await screen.findByRole('button', { name: /Bekleyen/ });
    // Positive anchor: a sibling chip HAS its number, so the page is settled
    // and the missing one is missing rather than pending.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Atanmamış/ })).toHaveTextContent('41'),
    );

    expect(waiting).not.toHaveTextContent('0');
    expect(within(waiting).getByTitle('Sayı alınamadı')).toBeInTheDocument();
    // And it is still a filter — a count we could not fetch does not disable
    // the queue it labels.
    expect(waiting).toBeEnabled();
  });
});

describe('LeadsPage — embedded as the Kişiler tab', () => {
  beforeEach(() => {
    listLeads.mockReset();
    listLeads.mockResolvedValue(PAGE);
  });

  it('drops its own header but never its actions', async () => {
    const { rerender } = render(<LeadsPage />, { wrapper });
    await screen.findByText('Acme');
    // Standalone: it owns the page, so it owns the heading.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    rerender(<LeadsPage embedded />);
    await screen.findByText('Acme');
    // Embedded: the host rendered the heading; a second one would stack.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    // The actions move, they do not vanish.
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /leads.createButton/ })).toBeInTheDocument();
  });
});
