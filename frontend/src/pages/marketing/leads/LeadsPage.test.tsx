import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import LeadsPage from './LeadsPage';

const listLeads = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  listLeads: (...a: unknown[]) => listLeads(...a),
  bulkAssignLeads: vi.fn(),
  bulkDeleteLeads: vi.fn(),
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
