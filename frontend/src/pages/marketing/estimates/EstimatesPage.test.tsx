import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import EstimatesPage, { formFromEstimate, computeFormTotals } from './EstimatesPage';
import type { Estimate } from '../../../features/marketing/api/estimates.service';

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

// The REAL list endpoint omits `items` and `notes` (it selects a summary) — so
// the list fixture must NOT carry them; the full record comes from GET /:id.
const LIST_ROW = {
  id: 'e1',
  leadId: null,
  number: 'EST-ABCD',
  currency: 'USD',
  total: 9900,
  validUntil: null,
  status: 'DRAFT',
  convertedInvoiceId: null,
  createdAt: '2026-06-21T00:00:00Z',
};

const DETAIL = {
  ...LIST_ROW,
  items: [{ description: 'Plan', qty: 1, unitPrice: 9900, taxRateId: 'tr1', taxRatePct: 20 }],
  notes: 'internal note',
};

const TAX_RATES = [{ id: 'tr1', name: 'KDV', rate: 20, isDefault: true, archived: false }];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('EstimatesPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) => {
      if (url === '/estimates') return Promise.resolve({ data: [LIST_ROW] });
      if (url === '/estimates/e1') return Promise.resolve({ data: DETAIL });
      if (url === '/tax-rates') return Promise.resolve({ data: TAX_RATES });
      return Promise.resolve({ data: {} });
    });
  });

  it('lists estimates with number and formatted total', async () => {
    render(<EstimatesPage />, { wrapper });
    expect(await screen.findByText('EST-ABCD')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/estimates');
  });

  // Regression: the list omits items, so opening edit must fetch the full
  // estimate (GET /:id). Otherwise the editor opens empty and a save wipes the
  // line items. Proven via the tax-inclusive total, which only appears if the
  // real line item (with its 20% rate) was loaded.
  it('loads the full estimate on edit and shows its tax-inclusive total', async () => {
    const user = userEvent.setup();
    render(<EstimatesPage />, { wrapper });
    await screen.findByText('EST-ABCD');

    await user.click(screen.getByTitle('Edit'));

    await waitFor(() => expect(get).toHaveBeenCalledWith('/estimates/e1'));
    const dialog = await screen.findByRole('dialog');
    // 99.00 subtotal + 20% KDV = 118.80 — only reachable if items were loaded.
    expect(await within(dialog).findByText(/118[.,]80/)).toBeInTheDocument();
  });

  // Convert mints an invoice; a double-click fires it twice and the second hits
  // the backend's already-converted guard, surfacing a spurious error toast
  // after the first succeeded. The in-flight guard must be scoped to the acting
  // estimate so its Convert locks while running — without disabling the others.
  it('disables only the acting estimate\'s Convert button while it is in flight', async () => {
    const user = userEvent.setup();
    const sent = (id: string, number: string) => ({ ...LIST_ROW, id, number, status: 'SENT' });
    get.mockImplementation((url: string) => {
      if (url === '/estimates') return Promise.resolve({ data: [sent('e1', 'EST-1'), sent('e2', 'EST-2')] });
      if (url === '/tax-rates') return Promise.resolve({ data: TAX_RATES });
      return Promise.resolve({ data: {} });
    });
    post.mockImplementation(() => new Promise(() => {})); // convert never resolves → stays pending

    render(<EstimatesPage />, { wrapper });
    await screen.findByText('EST-1');

    const convertBtns = screen.getAllByTitle('Convert to invoice');
    expect(convertBtns).toHaveLength(2);
    await user.click(convertBtns[0]);
    expect(post).toHaveBeenCalledWith('/estimates/e1/convert');

    const after = screen.getAllByTitle('Convert to invoice');
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});

describe('formFromEstimate', () => {
  const detail = (over: Partial<Estimate> = {}): Estimate =>
    ({ ...DETAIL, ...over }) as unknown as Estimate;

  it('preserves items (minor→major price), notes and validUntil', () => {
    const form = formFromEstimate(
      detail({ validUntil: '2026-07-15T00:00:00Z', notes: 'hi' }),
    );
    expect(form.id).toBe('e1');
    expect(form.notes).toBe('hi');
    expect(form.validUntil).toBe('2026-07-15');
    expect(form.items).toEqual([
      { description: 'Plan', qty: '1', price: '99', taxRateId: 'tr1' },
    ]);
  });

  it('yields an empty item list (not a crash) when the estimate has none', () => {
    const form = formFromEstimate(detail({ items: [], notes: null }));
    expect(form.items).toEqual([]);
    expect(form.notes).toBe('');
  });
});

// The live total preview and the save payload must agree. The payload drops
// line items with a blank description, so the preview must too — otherwise an
// in-progress, description-less line inflates the previewed total and then
// silently vanishes on save (persisted total < shown total).
describe('computeFormTotals', () => {
  const pctOf = (id?: string) => (id === 'tr1' ? 20 : 0);

  it('excludes blank-description lines so the preview matches what is saved', () => {
    const totals = computeFormTotals(
      [
        { description: 'Plan', qty: '1', price: '99', taxRateId: 'tr1' }, // 9900 + 20% = 11880
        { description: '   ', qty: '5', price: '50' }, // blank desc → dropped on save → must NOT count
      ],
      pctOf,
    );
    expect(totals.subtotal).toBe(9900);
    expect(totals.tax).toBe(1980);
    expect(totals.total).toBe(11880);
  });

  it('sums described lines with per-line exclusive tax in minor units', () => {
    const totals = computeFormTotals(
      [
        { description: 'A', qty: '2', price: '10', taxRateId: 'tr1' }, // 2000 + 20% = 2400
        { description: 'B', qty: '1', price: '5' }, // 500, no tax
      ],
      pctOf,
    );
    expect(totals.subtotal).toBe(2500);
    expect(totals.tax).toBe(400);
    expect(totals.total).toBe(2900);
  });
});
