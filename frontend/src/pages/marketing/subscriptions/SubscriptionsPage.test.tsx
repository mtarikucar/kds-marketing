import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionsPage, { formFromSubscription } from './SubscriptionsPage';

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

const SUBS = [
  {
    id: 's1',
    name: 'Gold membership',
    leadId: null,
    amount: 9900,
    currency: 'USD',
    interval: 'MONTH',
    intervalCount: 1,
    status: 'ACTIVE',
    nextBillingAt: '2026-07-01T00:00:00Z',
    lastBilledAt: null,
    invoicesGenerated: 0,
    createdAt: '2026-06-01T00:00:00Z',
  },
];

// Full record the detail endpoint returns (list omits items/dueDays/notes).
const SUB_DETAIL = {
  ...SUBS[0],
  items: [{ description: 'Seat', qty: 2, unitPrice: 10000 }],
  dueDays: 30,
  notes: 'vip',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SubscriptionsPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) => {
      if (url === '/subscriptions') return Promise.resolve({ data: SUBS });
      if (url === '/subscriptions/s1') return Promise.resolve({ data: SUB_DETAIL });
      return Promise.resolve({ data: { data: [] } }); // products
    });
  });

  it('lists subscriptions with name and status', async () => {
    render(<SubscriptionsPage />, { wrapper });
    expect(await screen.findByText('Gold membership')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/subscriptions');
  });

  // Regression: editing must load the full record (with items), not seed an
  // empty one-row draft that would wipe the plan's items + amount on save.
  it('loads the full subscription (with items) when opening edit', async () => {
    render(<SubscriptionsPage />, { wrapper });
    await screen.findByText('Gold membership');

    fireEvent.click(screen.getByTitle('Edit'));

    await waitFor(() => expect(get).toHaveBeenCalledWith('/subscriptions/s1'));
    // The real line item appears in the editor instead of a blank row.
    expect(await screen.findByDisplayValue('Seat')).toBeInTheDocument();
  });

  // Cancelling a subscription is irreversible (no un-cancel path); it must be
  // confirmed, like the other destructive actions in the app.
  it('does NOT cancel when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SubscriptionsPage />, { wrapper });
    await screen.findByText('Gold membership');

    fireEvent.click(screen.getByTitle('Cancel'));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalledWith('/subscriptions/s1/cancel');
    vi.restoreAllMocks();
  });

  it('cancels when the confirmation is accepted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SubscriptionsPage />, { wrapper });
    await screen.findByText('Gold membership');

    fireEvent.click(screen.getByTitle('Cancel'));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/subscriptions/s1/cancel'),
    );
    vi.restoreAllMocks();
  });
});

describe('formFromSubscription', () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    ...SUB_DETAIL,
    intervalCount: 2,
    items: [
      { description: 'Seat', qty: 2, unitPrice: 10000 },
      { description: 'Setup', qty: 1, unitPrice: 10000 },
    ],
    ...over,
  });

  it('preserves the existing items, dueDays and minor→major price on edit', () => {
    const form = formFromSubscription(detail() as never);
    expect(form.id).toBe('s1');
    expect(form.intervalCount).toBe('2');
    expect(form.dueDays).toBe('30');
    expect(form.items).toEqual([
      { description: 'Seat', qty: '2', price: '100' },
      { description: 'Setup', qty: '1', price: '100' },
    ]);
  });

  it('falls back to one empty row when the plan genuinely has no items', () => {
    const form = formFromSubscription(detail({ items: [], dueDays: 14 }) as never);
    expect(form.items).toHaveLength(1);
    expect(form.items[0].description).toBe('');
    expect(form.dueDays).toBe('14');
  });

  it('defaults dueDays to 14 when the record omits it', () => {
    const form = formFromSubscription(detail({ dueDays: undefined }) as never);
    expect(form.dueDays).toBe('14');
  });
});
