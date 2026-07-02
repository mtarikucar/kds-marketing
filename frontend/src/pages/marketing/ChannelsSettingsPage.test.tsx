import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  // Regression: opening the create dialog renders the "answering agent" Select,
  // whose placeholder option used value="" — which modern Radix Select throws on
  // ("Select.Item must have a value prop that is not an empty string"), crashing
  // the whole page. Opening the dialog must NOT throw.
  it('opens the create channel dialog without crashing (no empty-value Select.Item)', async () => {
    render(<ChannelsSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /connect a channel|channels\.new/i });
    await userEvent.click(btns[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
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

  it('disables the Meta connect button until the Facebook app is configured', async () => {
    // Default status mock returns [] → no FACEBOOK flag → button stays disabled.
    render(<ChannelsSettingsPage />, { wrapper });
    const btn = await screen.findByRole('button', { name: /Connect Messenger & Instagram/i });
    expect(btn).toBeDisabled();
  });

  it('starts the Meta OAuth with origin=channels when the app is configured', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
    marketingApi.get.mockImplementation((url: string) =>
      url.includes('/social-planner/status')
        ? Promise.resolve({ data: { FACEBOOK: true } })
        : Promise.resolve({ data: [] }),
    );
    marketingApi.post.mockResolvedValue({ data: { authorizeUrl: 'https://facebook.com/authorize' } });
    render(<ChannelsSettingsPage />, { wrapper });
    const btn = await screen.findByRole('button', { name: /Connect Messenger & Instagram/i });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    expect(marketingApi.post).toHaveBeenCalledWith('/social/oauth/facebook/start', { origin: 'channels' });
  });

  it('opens the account picker on return from OAuth (?connect=)', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
    marketingApi.get.mockImplementation((url: string) =>
      url.includes('/social/oauth/pending/')
        ? Promise.resolve({
            data: {
              network: 'FACEBOOK',
              assets: [{ externalId: 'P1', displayName: 'Acme', accountType: 'PAGE' }],
            },
          })
        : Promise.resolve({ data: [] }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channels?connect=pend1']}>
          <ChannelsSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The channel-context picker uses its own title + lists the granted Page.
    expect(await screen.findByText(/Connect messaging channels/i)).toBeInTheDocument();
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});
