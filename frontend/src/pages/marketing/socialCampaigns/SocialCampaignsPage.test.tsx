import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const listSocialCampaigns = vi.fn();
vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
  listSocialCampaigns: () => listSocialCampaigns(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string) => d ?? _k,
    i18n: { language: 'en' },
  }),
}));

import SocialCampaignsPage from './SocialCampaignsPage';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SocialCampaignsPage', () => {
  beforeEach(() => listSocialCampaigns.mockReset());

  it('renders campaign rows returned by the service', async () => {
    listSocialCampaigns.mockResolvedValue([
      { id: 'sc1', name: 'Summer Launch', status: 'ACTIVE', automationMode: 'APPROVAL' },
    ]);
    render(<SocialCampaignsPage />, { wrapper });
    expect(await screen.findByText('Summer Launch')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('shows an empty state when there are no campaigns', async () => {
    listSocialCampaigns.mockResolvedValue([]);
    render(<SocialCampaignsPage />, { wrapper });
    expect(await screen.findByText('No social campaigns yet')).toBeInTheDocument();
  });
});
