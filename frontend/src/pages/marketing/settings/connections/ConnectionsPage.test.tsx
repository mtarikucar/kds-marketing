import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ConnectionsPage from './ConnectionsPage';

vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    // SSO list + Slack list resolve to []; Google status resolves to
    // not-configured so the calendar tab renders its operator notice.
    get: vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('google-calendar/status')) {
        return Promise.resolve({ data: { configured: false, connections: [] } });
      }
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

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

describe('ConnectionsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<ConnectionsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the SSO create dialog and validates empty required fields', async () => {
    render(<ConnectionsPage />, { wrapper });
    // The SSO tab is active by default; open its create dialog.
    const newBtn = screen.getAllByRole('button', { name: /new sso connection/i })[0];
    await userEvent.click(newBtn);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    // Submit with empty issuer/clientId → validation errors (role=alert) appear.
    const candidates = screen.getAllByRole('button', { name: /new sso connection|save/i });
    const saveBtn = candidates[candidates.length - 1];
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
