import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TelephonySettingsPage from './TelephonySettingsPage';

const api = { get: vi.fn(), put: vi.fn(), patch: vi.fn() };
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: any[]) => api.get(...a),
    put: (...a: any[]) => api.put(...a),
    patch: (...a: any[]) => api.patch(...a),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: any) => (typeof d === 'string' ? d : d?.defaultValue) ?? k,
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

describe('TelephonySettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: null });
    api.put.mockResolvedValue({ data: { configuredSecrets: [] } });
  });

  it('mounts and renders the heading', () => {
    render(<TelephonySettingsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
