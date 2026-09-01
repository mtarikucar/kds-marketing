import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { PeopleList } from './PeopleList';
import type { Lead } from '../../../features/marketing/types';

const listLeads = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  listLeads: (...a: unknown[]) => listLeads(...a),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

/** A person, with only the fields a row reads. */
const person = (over: Partial<Lead> & Pick<Lead, 'id'>): Lead =>
  ({
    businessName: `Firma ${over.id}`,
    contactPerson: `Kişi ${over.id}`,
    businessType: 'OTHER',
    source: 'OTHER',
    status: 'NEW',
    priority: 'MEDIUM',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    unreadCount: 0,
    lastMessageAt: null,
    lastMessagePreview: null,
    ...over,
  }) as Lead;

const page = (rows: Lead[], total = rows.length, limit = 25) => ({
  data: rows,
  meta: { total, page: 1, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
});

/** Records the URL so a test can prove a click did NOT navigate. */
let seenPath = '';
function PathProbe() {
  const loc = useLocation();
  seenPath = `${loc.pathname}${loc.search}`;
  return null;
}

function renderList(
  props: Partial<React.ComponentProps<typeof PeopleList>> = {},
  entries: string[] = ['/leads'],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entries}>
        <PathProbe />
        <Routes>
          <Route path="*" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    wrap(<PeopleList selectedId={null} onSelect={() => {}} {...props} />),
  );
}

/** The list query, ignoring the three `limit: 1` chip-count probes. */
const listCalls = () =>
  listLeads.mock.calls.map((c) => c[0]).filter((p: { limit?: number }) => p.limit !== 1);

beforeEach(() => {
  listLeads.mockReset();
  seenPath = '';
  listLeads.mockImplementation((p: { limit?: number }) =>
    Promise.resolve(p.limit === 1 ? page([], 0, 1) : page([person({ id: 'p1' })])),
  );
});

describe('PeopleList — one list, and it is people', () => {
  // The owner's own decision. People with conversations rise by recency; the
  // ~363 silent leads fall below them, ordered by when they arrived. The
  // backend guarantees `lastActivityAt` is never null, which is the only reason
  // this single sort can carry both groups.
  it('orders by last activity, newest first, without being asked', async () => {
    renderList();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0]).toMatchObject({
      sortBy: 'lastActivityAt',
      sortOrder: 'desc',
    });
  });

  it('shows what was last said and how much of it is unread', async () => {
    listLeads.mockImplementation((p: { limit?: number }) =>
      Promise.resolve(
        p.limit === 1
          ? page([], 0, 1)
          : page([
              person({
                id: 'p1',
                contactPerson: 'Ayşe Yılmaz',
                lastMessageAt: '2026-08-20T10:00:00Z',
                lastMessagePreview: 'Fiyat listesini alabilir miyim?',
                unreadCount: 3,
              }),
            ]),
      ),
    );

    renderList();

    const row = await screen.findByTestId('person-row-p1');
    expect(row).toHaveTextContent('Ayşe Yılmaz');
    expect(row).toHaveTextContent('Fiyat listesini alabilir miyim?');
    expect(within(row).getByTestId('person-unread-p1')).toHaveTextContent('3');
  });

  it('does not put an unread badge on a person with nothing unread', async () => {
    renderList();

    const row = await screen.findByTestId('person-row-p1');
    expect(within(row).queryByTestId('person-unread-p1')).not.toBeInTheDocument();
  });
});

/**
 * The whole point of the correction. v2.283.0 put the two lists on one page and
 * clicking a person still went to `/leads/:id` — two objects, two behaviours,
 * moved but not merged. A row is a SELECTION.
 */
describe('PeopleList — selecting is not navigating', () => {
  it('reports the selection and leaves the URL exactly where it was', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderList({ onSelect });

    const before = seenPath;
    await user.click(await screen.findByTestId('person-row-p1'));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    expect(seenPath).toBe(before);
  });

  it('has no link out of a row at all — a link is a navigation waiting to happen', async () => {
    renderList();

    const row = await screen.findByTestId('person-row-p1');
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  });

  it('marks the selected person so the three columns agree on who is open', async () => {
    listLeads.mockImplementation((p: { limit?: number }) =>
      Promise.resolve(
        p.limit === 1
          ? page([], 0, 1)
          : page([person({ id: 'p1' }), person({ id: 'p2' })]),
      ),
    );

    renderList({ selectedId: 'p2' });

    await screen.findByTestId('person-row-p1');
    expect(screen.getByTestId('person-row-p2')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('person-row-p1')).toHaveAttribute('aria-current', 'false');
  });

  // A silent lead is 363 of the 400 rows and the reason the merge could not be
  // "the conversation list, renamed".
  it('lets a person who has never been messaged be selected like anyone else', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    listLeads.mockImplementation((p: { limit?: number }) =>
      Promise.resolve(
        p.limit === 1
          ? page([], 0, 1)
          : page([
              person({
                id: 'silent',
                contactPerson: 'Sessiz Kişi',
                lastMessageAt: null,
                lastMessagePreview: null,
                unreadCount: 0,
              }),
            ]),
      ),
    );

    renderList({ onSelect });

    await user.click(await screen.findByTestId('person-row-silent'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'silent' }));
  });
});

describe('PeopleList — the work queue reaches the silent ones', () => {
  it('keeps /leads?assignmentStatus=unassigned resolving, and lights that chip', async () => {
    // The dashboard's triage deep link (NeedsAttention, DashboardHero). It
    // predates this surface and now lands on it, so it has to be read HERE.
    renderList({}, ['/leads?assignmentStatus=unassigned']);

    await screen.findByTestId('person-row-p1');
    expect(screen.getByRole('button', { name: /Atanmamış/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(listCalls()[0]).toMatchObject({ assignmentStatus: 'unassigned' });
  });

  it('switches the queue when a chip is pressed', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByTestId('person-row-p1');

    await user.click(screen.getByRole('button', { name: /Bekleyen/ }));

    await waitFor(() => {
      const last = listCalls()[listCalls().length - 1];
      expect(last.waitingReply).toBe(true);
      // Single-select: the chips own both dimensions, so one never stacks
      // silently under another.
      expect(last.assignmentStatus).toBeUndefined();
    });
  });

  it('sorts by last activity in every queue, not only the default one', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByTestId('person-row-p1');

    await user.click(screen.getByRole('button', { name: /Bekleyen/ }));

    await waitFor(() => {
      const last = listCalls()[listCalls().length - 1];
      expect(last.sortBy).toBe('lastActivityAt');
    });
  });
});

/**
 * The repo's central rule, applied to the column that feeds the other two: a
 * broken list and an empty one are different screens, and a broken list must
 * say which source failed rather than showing "nobody here".
 */
describe('PeopleList — a failure is never an empty list', () => {
  it('names the failure and offers a retry instead of claiming there is nobody', async () => {
    listLeads.mockImplementation((p: { limit?: number }) =>
      p.limit === 1 ? Promise.resolve(page([], 0, 1)) : Promise.reject(new Error('boom')),
    );

    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('Kişiler yüklenemedi');
    expect(screen.queryByTestId('people-empty')).not.toBeInTheDocument();
  });

  it('says the list is empty when it genuinely is', async () => {
    listLeads.mockImplementation(() => Promise.resolve(page([], 0)));

    renderList();

    expect(await screen.findByTestId('people-empty')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries the list when asked', async () => {
    const user = userEvent.setup();
    listLeads.mockImplementation((p: { limit?: number }) =>
      p.limit === 1 ? Promise.resolve(page([], 0, 1)) : Promise.reject(new Error('boom')),
    );

    renderList();
    await screen.findByRole('alert');

    const before = listCalls().length;
    await user.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
  });
});

/**
 * Stage 3 of the one-screen brief. `Şirketler` is not a field of a person —
 * `Company` has no `leadId` — so it does not become a section of the record
 * card. It becomes a GROUPING of this list, and `/companies` keeps its route
 * and every capability it has.
 *
 * The grouping is an ORDER the server settles across the whole filtered set
 * (`sortBy=company`), not a bucketing of the 25 rows this column happens to
 * hold. Bucketing the page would have been cheaper and would have lied: a
 * header reading "Acme · 3" over a company with forty contacts is worse than
 * no grouping at all.
 */
describe('PeopleList — grouping by company', () => {
  const grouped = (rows: Lead[]) =>
    listLeads.mockImplementation((p: { limit?: number }) =>
      Promise.resolve(p.limit === 1 ? page([], 0, 1) : page(rows)),
    );

  it('is off by default: the owner’s activity sort, and no headers', async () => {
    renderList();

    await screen.findByTestId('person-row-p1');
    expect(listCalls()[0]).toMatchObject({ sortBy: 'lastActivityAt' });
    expect(screen.queryByTestId('people-group-none')).not.toBeInTheDocument();
    expect(screen.getByTestId('group-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('asks the SERVER to group, and says so in the URL', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByTestId('person-row-p1');

    await user.click(screen.getByTestId('group-toggle'));

    await waitFor(() => {
      expect(listCalls()[listCalls().length - 1]).toMatchObject({ sortBy: 'company' });
    });
    // In the URL for PeopleList's own two reasons: a colleague can be sent one,
    // and a reload must not silently rearrange somebody's queue.
    expect(seenPath).toContain('group=company');
  });

  it('reads ?group=company from a deep link and heads each company’s block', async () => {
    grouped([
      person({ id: 'a1', contactPerson: 'Ali', company: { id: 'c-2', name: 'Acme AŞ' } }),
      person({ id: 'z1', contactPerson: 'Zehra', company: { id: 'c-1', name: 'Zeta Ltd' } }),
    ]);

    renderList({}, ['/leads?group=company']);

    await screen.findByTestId('person-row-a1');
    expect(screen.getByTestId('group-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('people-group-c-2')).toHaveTextContent('Acme AŞ');
    expect(screen.getByTestId('people-group-c-1')).toHaveTextContent('Zeta Ltd');
  });

  /**
   * The failure this whole line of work exists to prevent. A person with no
   * company is not a person without a place: they get a NAMED trailing block,
   * and they stay selectable exactly like anyone else.
   */
  it('gives the people with no company a block of their own, and keeps them selectable', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    grouped([
      person({ id: 'a1', company: { id: 'c-2', name: 'Acme AŞ' } }),
      person({ id: 'solo', contactPerson: 'Yalnız Kişi', company: null }),
    ]);

    renderList({ onSelect }, ['/leads?group=company']);

    // Anchored on a positive find, so "the header is absent" can never pass by
    // rendering nothing at all.
    await screen.findByTestId('person-row-solo');
    expect(screen.getByTestId('people-group-none')).toHaveTextContent('Şirketsiz');

    await user.click(screen.getByTestId('person-row-solo'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'solo' }));
  });

  it('never drops a person the server sent, grouped or not', async () => {
    grouped([
      person({ id: 'a1', company: { id: 'c-2', name: 'Acme AŞ' } }),
      person({ id: 'a2', company: { id: 'c-2', name: 'Acme AŞ' } }),
      person({ id: 'solo', company: null }),
      person({ id: 'ghost' }), // the field absent entirely, not merely null
    ]);

    renderList({}, ['/leads?group=company']);

    await screen.findByTestId('person-row-a1');
    for (const id of ['a1', 'a2', 'solo', 'ghost']) {
      expect(screen.getByTestId(`person-row-${id}`)).toBeInTheDocument();
    }
    // One header per company, not one per row.
    expect(screen.getAllByTestId('people-group-c-2')).toHaveLength(1);
  });

  it('turns the grouping off again, restoring the activity sort', async () => {
    const user = userEvent.setup();
    renderList({}, ['/leads?group=company']);
    await screen.findByTestId('person-row-p1');

    await user.click(screen.getByTestId('group-toggle'));

    await waitFor(() => {
      expect(listCalls()[listCalls().length - 1]).toMatchObject({ sortBy: 'lastActivityAt' });
    });
    expect(seenPath).not.toContain('group=');
    expect(screen.queryByTestId('people-group-none')).not.toBeInTheDocument();
  });

  it('keeps the queue chips working while grouped — a grouping is not a filter', async () => {
    const user = userEvent.setup();
    renderList({}, ['/leads?group=company']);
    await screen.findByTestId('person-row-p1');

    await user.click(screen.getByRole('button', { name: /Atanmamış/ }));

    await waitFor(() => {
      const last = listCalls()[listCalls().length - 1];
      expect(last).toMatchObject({ assignmentStatus: 'unassigned', sortBy: 'company' });
    });
  });
});
