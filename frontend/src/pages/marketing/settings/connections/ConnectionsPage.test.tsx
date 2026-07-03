import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import ConnectionsPage from './ConnectionsPage';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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

/** Wrapper that seeds the URL with the Google OAuth callback result params. */
function routerWith(initialEntry: string) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('ConnectionsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<ConnectionsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  // SSO + Slack moved to the Account Center (they're workspace/company-level); this
  // page is now personal — only the user's own Google/Outlook calendar.
  it('defaults to a personal calendar tab (no SSO/Slack here)', () => {
    render(<ConnectionsPage />, { wrapper });
    expect(screen.queryByRole('button', { name: /new sso connection/i })).toBeNull();
  });

  it('shows a success toast when the Google callback returns ?gcal=connected', async () => {
    render(<ConnectionsPage />, { wrapper: routerWith('/settings/connections?gcal=connected') });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Google Calendar connected'),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the precise cause when the callback returns ?gcal=error&reason=exchange_invalid_client', async () => {
    render(<ConnectionsPage />, {
      wrapper: routerWith('/settings/connections?gcal=error&reason=exchange_invalid_client'),
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('invalid_client'),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
