import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TwoFactorPage from './TwoFactorPage';

// Hoisted so the vi.mock factory (itself hoisted to the top of the file) can
// reference it without a "used before initialization" error.
const { QR_DATA_URI } = vi.hoisted(() => ({
  QR_DATA_URI: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQ',
}));

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { enabled: false } }),
    post: vi.fn().mockResolvedValue({
      data: { secret: 'JBSWY3DP', otpauthUri: 'otpauth://x', qrDataUri: QR_DATA_URI },
    }),
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

  it('renders the QR from the server data URI, never a third-party QR service', async () => {
    render(<TwoFactorPage />, { wrapper });
    const begin = await screen.findByRole('button', { name: /begin setup/i });
    await userEvent.click(begin);
    // The otpauth URI embeds the TOTP secret; it must never be handed to an
    // external renderer like api.qrserver.com. The <img> uses the server-rendered
    // data URI directly.
    const qr = await screen.findByRole('img', { name: /two-factor qr code/i });
    expect(qr).toHaveAttribute('src', QR_DATA_URI);
    expect(qr.getAttribute('src')).not.toMatch(/qrserver\.com/);
  });
});
