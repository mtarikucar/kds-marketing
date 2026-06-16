import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TwoFactorPage from './TwoFactorPage';

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { enabled: false } }),
    post: vi.fn().mockResolvedValue({ data: { secret: 'JBSWY3DP', otpauthUri: 'otpauth://x' } }),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
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

describe('TwoFactorPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<TwoFactorPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('begins enrollment and validates an empty verification code', async () => {
    render(<TwoFactorPage />, { wrapper });
    // Start enrollment → QR + secret + verify form appear.
    const begin = await screen.findByRole('button', { name: /begin setup/i });
    await userEvent.click(begin);
    const verify = await screen.findByRole('button', { name: /verify & enable/i });
    // Submit with an empty code → a validation error appears in the field.
    await userEvent.click(verify);
    expect(await screen.findByText(/enter the 6-digit code/i)).toBeInTheDocument();
  });
});
