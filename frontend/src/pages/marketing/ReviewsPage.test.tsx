import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ReviewsPage from './ReviewsPage';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
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

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ReviewsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<ReviewsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the Review sources section', () => {
    render(<ReviewsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });

  it('renders an "Add" button for sources', () => {
    render(<ReviewsPage />, { wrapper });
    expect(screen.getByRole('button', { name: /add|reviews\.addSource/i })).toBeInTheDocument();
  });

  it('shows validation error when adding source with empty URL', async () => {
    render(<ReviewsPage />, { wrapper });
    // fill name only, leave URL empty
    const nameInput = screen.getByPlaceholderText(/name|reviews\.sourceName/i);
    await userEvent.type(nameInput, 'Google');
    await userEvent.click(screen.getByRole('button', { name: /add|reviews\.addSource/i }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
