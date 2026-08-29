import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LeadDetailPage from './LeadDetailPage';
import * as conversationsService from '../../../features/marketing/api/conversations.service';
import * as opportunitiesService from '../../../features/marketing/api/opportunities.service';

/**
 * Spec §"Hata davranışı" / §Test: "bir sekmenin hatası diğerlerini düşürmüyor".
 *
 * This lives in its OWN file rather than in LeadDetailPage.test.tsx because
 * that file stubs `./ConversationsTab` and `./SalesTab` to null, and `vi.mock`
 * is file-scoped and hoisted — a failure-isolation test written there could
 * only ever prove that two stubs do not interfere with each other. Here the
 * two tabs are REAL and it is their SERVICE modules that are mocked, so the
 * failing query is a real failing query.
 *
 * The trap this test is written around: `components/ui/Tabs.tsx` uses plain
 * Radix `TabsContent` with no `forceMount`, so an inactive tab is UNMOUNTED
 * and fires no query at all. "The Satış tab still works while Konuşmalar is
 * broken" is therefore VACUOUSLY true if you merely render the page and look
 * at the default tab — nothing else was ever mounted. The assertion that
 * carries weight is the sequence: open the broken tab, SEE it fail by name,
 * then navigate on from it and see the next tab render its data. If the
 * failure escaped its boundary (an unguarded throw, an error boundary
 * swallowing the page, a strip that unmounts with its content) the second
 * navigation is what would no longer be possible.
 */

const getLead = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  getLead: (...a: unknown[]) => getLead(...a),
  deleteLead: vi.fn(),
  updateLeadStatus: vi.fn(),
  createLeadActivity: vi.fn(),
  createOffer: vi.fn(),
  sendOffer: vi.fn(),
  deleteOffer: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  deleteTask: vi.fn(),
  convertLead: vi.fn(),
  reopenLead: vi.fn(),
}));

vi.mock('../../../features/marketing/api/conversations.service');
vi.mock('../../../features/marketing/api/opportunities.service');

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: 'MANAGER', id: 'u1' } }),
}));

vi.mock('../../../features/marketing/hooks/useBreadcrumbLabel', () => ({
  useBreadcrumbLabel: vi.fn(),
}));

// Only the panels that are NOT under test are stubbed. ConversationsTab and
// SalesTab are deliberately left real — they are the subject.
vi.mock('../../../features/marketing/components', () => ({
  LeadStatusBadge: () => null,
  AssignCell: () => null,
}));
vi.mock('./ContactInfo', () => ({ default: () => null }));
vi.mock('./WalletPanel', () => ({ WalletPanel: () => null }));
vi.mock('./CompanyPanel', () => ({ CompanyPanel: () => null }));
vi.mock('./ActivityTimelineTab', () => ({ default: () => null }));
vi.mock('./OffersTab', () => ({ default: () => null }));
vi.mock('./TasksTab', () => ({ default: () => null }));
vi.mock('./ConvertDialog', () => ({ default: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

const listConversations = vi.mocked(conversationsService.listConversations);
const listOpportunities = vi.mocked(opportunitiesService.listOpportunities);
const listPipelines = vi.mocked(opportunitiesService.listPipelines);

const LEAD = {
  id: 'l1',
  businessName: 'Acme',
  contactPerson: 'Jane',
  status: 'NEW',
  convertedTenantId: null,
  assignedTo: null,
  companyId: null,
  offers: [],
  tasks: [],
  activities: [],
  createdAt: '2026-06-01T00:00:00Z',
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/leads/l1']}>
        <Routes>
          <Route path="/leads" element={<div data-testid="leads-list" />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LeadDetailPage — one tab’s failure does not take the others down', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getLead.mockResolvedValue(LEAD);
    listPipelines.mockResolvedValue([
      {
        id: 'p1',
        name: 'Varsayılan',
        position: 0,
        isDefault: true,
        archived: false,
        stages: [
          {
            id: 's1',
            pipelineId: 'p1',
            name: 'Teklif',
            position: 0,
            probability: 40,
            isWon: false,
            isLost: false,
          },
        ],
      },
    ]);
  });

  it('names the broken tab, keeps the strip whole, and still opens Satış with its deals', async () => {
    const user = userEvent.setup();
    listConversations.mockRejectedValue(new Error('boom'));
    listOpportunities.mockResolvedValue({
      data: [
        {
          id: 'o1',
          pipelineId: 'p1',
          stageId: 's1',
          leadId: 'l1',
          assignedToId: null,
          name: 'Acme yıllık paket',
          value: 12000,
          currency: 'TRY',
          status: 'OPEN',
          source: null,
          notes: null,
          position: 0,
          lostReason: null,
          expectedCloseDate: null,
          wonAt: null,
          lostAt: null,
          createdAt: '2026-08-01T00:00:00Z',
          updatedAt: '2026-08-01T00:00:00Z',
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    } as Awaited<ReturnType<typeof opportunitiesService.listOpportunities>>);

    renderPage();

    // Konuşmalar: the query rejects, and the tab says so BY NAME rather than
    // showing the empty state ("nothing here" and "could not ask" are
    // different answers — this repo has paid for confusing them).
    await user.click(await screen.findByRole('tab', { name: 'Konuşmalar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Konuşmalar yüklenemedi.');
    expect(listConversations).toHaveBeenCalledWith({ leadId: 'l1' });

    // The strip survived the failure intact — all five, still in order.
    expect(screen.getAllByRole('tab').map((el) => el.textContent?.trim())).toEqual([
      'Etkinlik',
      'Konuşmalar',
      'Satış',
      'Teklifler (0)',
      'Görevler (0)',
    ]);

    // …and you can navigate ON from the broken tab into a working one, which
    // fetches and renders its own data.
    await user.click(screen.getByRole('tab', { name: 'Satış' }));
    expect(await screen.findByTestId('opportunity-o1')).toBeInTheDocument();
    expect(screen.getByText('Acme yıllık paket')).toBeInTheDocument();
    expect(listOpportunities).toHaveBeenCalledWith({ leadId: 'l1' });
  });
});
