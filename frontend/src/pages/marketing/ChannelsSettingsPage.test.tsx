import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
