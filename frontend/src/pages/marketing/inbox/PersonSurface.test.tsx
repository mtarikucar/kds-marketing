import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MERGED_SURFACE_ROUTES } from '../../../App';

/**
 * The route wiring, asserted against THE ROUTE TABLE THAT SHIPS.
 *
 * `/inbox` and `/leads` both render the person-primary surface, and after the
 * 2026-08-29 correction they render it identically — there are no tabs left for
 * them to differ about. Both paths stay: they are members of the frozen 50-path
 * set (navigation.test.ts) and they are in people's bookmarks. What merged is
 * the page, not the URL space.
 *
 * These tests import `MERGED_SURFACE_ROUTES` from App.tsx rather than building a
 * two-line copy of it. The copy is why this file's predecessor proved nothing:
 * deleting `defaultTab="contacts"` from App.tsx left all eleven of its tests
 * green while `/leads` opened on the wrong tab, because the fixture still
 * carried the prop the app had lost.
 */

const get = vi.fn().mockResolvedValue({ data: [] });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: vi.fn().mockResolvedValue({ data: {} }) },
}));

const listLeads = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  listLeads: (...a: unknown[]) => listLeads(...a),
}));
vi.mock('../../../features/marketing/api/conversations.service', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  startConversation: vi.fn(),
}));

// App.tsx's ~100 page imports are lazy(), so importing the module loads none of
// them — but the layout/guard shells are real imports, and the components
// barrel drags the SIP.js webphone into jsdom. None of it is under test here:
// this file mounts two route ELEMENTS, not the app shell.
vi.mock('../../../features/marketing/components/MarketingLayout', () => ({ default: () => null }));
vi.mock('../../../features/platform/components/PlatformLayout', () => ({ default: () => null }));
vi.mock('../../../features/marketing/hooks/useReferralCapture', () => ({
  useReferralCapture: () => {},
}));
vi.mock('../leadDetail/LeadHeaderActions', () => ({ default: () => null }));
vi.mock('../../../features/marketing/components/LeadStream', () => ({
  default: ({ leadId }: { leadId: string }) => <div data-testid="stream">stream:{leadId}</div>,
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { accessToken: 'tok', user: { role: 'MANAGER', id: 'u-1' } };
    return sel ? sel(state) : state;
  },
}));
vi.mock('../../../lib/env', () => ({ API_URL: 'http://test' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: () => true, isLoading: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ?? (Array.isArray(k) ? k[0] : k),
    i18n: { language: 'tr' },
  }),
}));

const PERSON = {
  id: 'p1',
  businessName: 'Acme',
  contactPerson: 'Ayşe',
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
};

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* THE route table, imported — not a second copy of it. */}
          {MERGED_SURFACE_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The list query, ignoring the three `limit: 1` chip-count probes. */
const listCalls = () =>
  listLeads.mock.calls.map((c) => c[0]).filter((p: { limit?: number }) => p.limit !== 1);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  listLeads.mockReset();
  listLeads.mockImplementation((p: { limit?: number }) =>
    Promise.resolve({
      data: p.limit === 1 ? [] : [PERSON],
      meta: { total: 1, page: 1, limit: p.limit ?? 25, totalPages: 1 },
    }),
  );
});

describe('The person surface — two routes, one page', () => {
  it('renders the three columns at /inbox', async () => {
    renderAt('/inbox');
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
    expect(await screen.findByTestId('person-row-p1')).toBeInTheDocument();
  });

  it('renders the same three columns at /leads', async () => {
    renderAt('/leads');
    expect(await screen.findByTestId('person-surface')).toBeInTheDocument();
    expect(await screen.findByTestId('person-row-p1')).toBeInTheDocument();
  });

  // The dashboard's triage deep link (NeedsAttention.tsx, DashboardHero.tsx).
  // It predates this surface and now lands on it.
  it('keeps /leads?assignmentStatus=unassigned resolving, filtered and lit', async () => {
    renderAt('/leads?assignmentStatus=unassigned');

    await screen.findByTestId('person-row-p1');
    expect(screen.getByRole('button', { name: /Atanmamış/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(listCalls()[0]).toMatchObject({ assignmentStatus: 'unassigned' });
  });
});
