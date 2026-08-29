import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SalesTab from './SalesTab';
import * as opportunitiesService from '../../../features/marketing/api/opportunities.service';
import type {
  Opportunity,
  Pipeline,
} from '../../../features/marketing/api/opportunities.service';
import type { PaginatedResponse } from '../../../features/marketing/types';

// Sibling convention (TimelinePanel.test.tsx): mock the SERVICE MODULE by path
// and drive it through `vi.mocked`, rather than spying on a namespace object.
vi.mock('../../../features/marketing/api/opportunities.service');

const listOpportunities = vi.mocked(opportunitiesService.listOpportunities);
const listPipelines = vi.mocked(opportunitiesService.listPipelines);

const opp = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: 'o1',
  pipelineId: 'p1',
  stageId: 's-demo',
  leadId: 'lead-1',
  assignedToId: null,
  name: 'Hasan Usta — 3 terminal',
  value: 42000,
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
  updatedAt: '2026-08-20T00:00:00Z',
  ...over,
});

const page = (data: Opportunity[]): PaginatedResponse<Opportunity> => ({
  data,
  meta: { total: data.length, page: 1, limit: 20, totalPages: 1 },
});

const PIPELINES: Pipeline[] = [
  {
    id: 'p1',
    name: 'Satış Hattı',
    position: 0,
    isDefault: true,
    archived: false,
    stages: [
      { id: 's-new', pipelineId: 'p1', name: 'Yeni', position: 0, probability: 10, isWon: false, isLost: false },
      { id: 's-demo', pipelineId: 'p1', name: 'Demo', position: 1, probability: 40, isWon: false, isLost: false },
    ],
  },
];

const fmtDate = (d: string | Date | null | undefined) => (d ? String(d).slice(0, 10) : '');

function renderTab(leadId = 'lead-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactNode) =>
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  return wrap(<SalesTab leadId={leadId} fmtDate={fmtDate} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  listOpportunities.mockResolvedValue(page([]));
  listPipelines.mockResolvedValue(PIPELINES);
});

describe('SalesTab', () => {
  it('lists this lead’s deals with the stage each one sits in', async () => {
    listOpportunities.mockResolvedValue(page([opp()]));

    renderTab();

    expect(await screen.findByText('Hasan Usta — 3 terminal')).toBeInTheDocument();
    // The stage is the point of the tab: a deal without one is just a number.
    // `listOpportunities` returns a bare `stageId`, so the name is resolved
    // through the pipelines query — this asserts that resolution happened.
    expect(await screen.findByText('Demo')).toBeInTheDocument();
  });

  // THE mutation this tab exists to survive. Drop `leadId` from the request and
  // the panel lists every opportunity in the workspace under one contact's
  // name — a page that looks completely normal and is completely wrong, which
  // is why no human review would catch it.
  it('asks the API for only this lead’s deals', async () => {
    renderTab('lead-42');
    await waitFor(() => expect(listOpportunities).toHaveBeenCalled());
    expect(listOpportunities).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'lead-42' }));
  });

  // No /opportunities/:id route exists in this app — the board IS the deal
  // surface — so "navigate to that opportunity" is the board deep-linked to
  // this deal, which OpportunitiesPage opens from `?deal=`.
  it('navigates each row to that specific deal, not to the board in general', async () => {
    listOpportunities.mockResolvedValue(page([opp({ id: 'o9', pipelineId: 'p1' })]));

    renderTab();

    const row = await screen.findByTestId('opportunity-o9');
    expect(row).toHaveAttribute('href', expect.stringContaining('deal=o9'));
    // Without the pipeline the board opens on the DEFAULT pipeline, where a deal
    // belonging to another pipeline is simply not present — the link would land
    // on a board that does not contain the deal it names.
    expect(row).toHaveAttribute('href', expect.stringContaining('pipelineId=p1'));
  });

  it('says there are no deals rather than showing a blank box', async () => {
    renderTab();
    expect(await screen.findByText(/Bu kişi için henüz fırsat yok/)).toBeInTheDocument();
  });

  // The empty state has to offer the next step, and that step must reuse the
  // board's own creation dialog carrying THIS lead — a second creation path
  // would be a second place for the lead link to be forgotten.
  it('offers to open the existing creation flow with this lead pre-filled', async () => {
    renderTab('lead-7');

    const cta = await screen.findByRole('link', { name: /fırsat oluştur/i });
    const href = cta.getAttribute('href') ?? '';
    expect(href).toContain('/opportunities');
    expect(href).toContain('create=1');
    expect(href).toContain('leadId=lead-7');
  });

  // Same load-bearing case as the Konuşmalar tab: "nothing to show" and "could
  // not load" are the same blank panel if the error is swallowed. Asserting an
  // alert appears is not enough — the empty state must be ABSENT, and with it
  // the create CTA, which on a failed fetch would invite a duplicate deal.
  it('reports a failed fetch instead of an empty deal list', async () => {
    listOpportunities.mockRejectedValue(new Error('boom'));

    renderTab();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Bu kişi için henüz fırsat yok/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /fırsat oluştur/i })).not.toBeInTheDocument();
  });

  // The stage name comes from a SECOND query. If that one fails the deals are
  // still real and must still be listed — but the tab must not quietly draw a
  // deal with no stage at all, which reads as "this deal has no stage" rather
  // than "we could not name it".
  it('still lists the deals when only the stage lookup fails, and says the stage is unknown', async () => {
    listOpportunities.mockResolvedValue(page([opp()]));
    listPipelines.mockRejectedValue(new Error('pipelines down'));

    renderTab();

    expect(await screen.findByText('Hasan Usta — 3 terminal')).toBeInTheDocument();
    expect(screen.getByText(/Bilinmeyen aşama/)).toBeInTheDocument();
  });
});
