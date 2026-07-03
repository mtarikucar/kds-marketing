import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ChannelsSettingsPage from './ChannelsSettingsPage';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// The OAuth "start" does a full-page redirect — stub it so jsdom doesn't navigate.
vi.mock('../../lib/navigateExternal', () => ({ navigateExternal: vi.fn() }));

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

describe('ChannelsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts and renders the page heading', () => {
    render(<ChannelsSettingsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  // Connecting a channel now lives in the Account Center; this page is
  // management-only, so it links there instead of opening an inline create dialog.
  it('links to the Account Center to connect a channel', async () => {
    render(<ChannelsSettingsPage />, { wrapper });
    const links = await screen.findAllByRole('link', { name: /account center/i });
    expect(links[0]).toHaveAttribute('href', '/accounts');
  });

  it('renders the LinkedIn dormant status when engagement is not granted', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
    marketingApi.get.mockImplementation((url: string) =>
      url === '/channels'
        ? Promise.resolve({
            data: [
              {
                id: 'li1',
                type: 'LINKEDIN',
                name: 'Company page',
                status: 'ACTIVE',
                configuredSecrets: ['accessToken'],
                configPublic: {},
              },
            ],
          })
        : Promise.resolve({ data: [] }),
    );
    render(<ChannelsSettingsPage />, { wrapper });
    expect(await screen.findByText(/Community Management access is approved/i)).toBeInTheDocument();
  });

  it('shows per-channel management (Verify) for an existing channel', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
    marketingApi.get.mockImplementation((url: string) =>
      url === '/channels'
        ? Promise.resolve({
            data: [
              { id: 'ch1', type: 'SMS', name: 'SMS line', status: 'ACTIVE', configuredSecrets: ['usercode'], configPublic: {}, agentProfileId: null },
            ],
          })
        : Promise.resolve({ data: [] }),
    );
    render(<ChannelsSettingsPage />, { wrapper });
    expect(await screen.findByText('SMS line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
  });
});
