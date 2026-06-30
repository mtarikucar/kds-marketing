import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a) },
}));
const createSocialCampaign = vi.fn();
vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
  createSocialCampaign: (...a: unknown[]) => createSocialCampaign(...a),
}));
const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignDetailDialog } from './CampaignDetailDialog';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CampaignDetailDialog', () => {
  beforeEach(() => { get.mockReset(); createSocialCampaign.mockReset(); navigate.mockReset(); });

  it('loads stats and recipients for the campaign', async () => {
    get.mockImplementation((url: string) =>
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [{ id: 'r1', leadId: 'l1', status: 'SENT', sentAt: null, openedAt: null, clickedAt: null, error: null }] })
        : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: { recipients: 1, sent: 1 } } }),
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    expect(await screen.findByText('l1')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/campaigns/c1');
    expect(get).toHaveBeenCalledWith('/campaigns/c1/recipients');
  });

  it('provisions a social campaign linked to this blast and navigates to it', async () => {
    get.mockImplementation((url: string) =>
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: {} } }),
    );
    createSocialCampaign.mockResolvedValue({ id: 'sc-new' });
    const user = userEvent.setup();
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    await screen.findByText('Promo');
    await user.click(screen.getByRole('button', { name: 'Create social content' }));
    expect(createSocialCampaign).toHaveBeenCalledTimes(1);
    expect(createSocialCampaign.mock.calls[0][0]).toMatchObject({ name: 'Promo', linkedCampaignId: 'c1' });
    expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-new');
  });
});
