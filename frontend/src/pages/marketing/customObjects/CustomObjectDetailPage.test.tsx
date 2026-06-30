import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import CustomObjectDetailPage from './CustomObjectDetailPage';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: 'MANAGER' } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? (Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

const obj = (key: string) => ({
  id: key,
  key,
  labelSingular: key,
  labelPlural: `${key}s`,
  primaryField: 'name',
  archived: false,
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CustomObjectDetailPage — transient state resets per object', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url.endsWith('/fields')) return Promise.resolve({ data: [] });
      if (url.includes('/records')) {
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } } });
      }
      const key = url.split('/').pop() ?? '';
      return Promise.resolve({ data: obj(key) });
    });
  });

  // Navigating to another custom object reuses this page (no remount), so a
  // search filter — or, worse, an open delete/archive confirm — for object A must
  // not carry to object B. Verify via the search filter (which the same effect
  // clears alongside the dialog state).
  it('clears the search filter when navigating to another object', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/custom-objects/property']}>
        <Routes>
          <Route path="/custom-objects/:key" element={<CustomObjectDetailPage />} />
        </Routes>
        <Link to="/custom-objects/vehicle">go-vehicle</Link>
      </MemoryRouter>,
      { wrapper },
    );

    const input = (await screen.findByPlaceholderText('Search records…')) as HTMLInputElement;
    await user.type(input, 'acme');
    expect(input.value).toBe('acme');

    await user.click(screen.getByText('go-vehicle'));

    await waitFor(() => {
      const inp = screen.getByPlaceholderText('Search records…') as HTMLInputElement;
      expect(inp.value).toBe('');
    });
  });
});
