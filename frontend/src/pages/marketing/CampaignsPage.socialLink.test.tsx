import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig() as object), useNavigate: () => navigate }));
vi.mock('../../features/marketing/api/social-link.service', () => ({
  provisionSocialFromCampaign: vi.fn().mockResolvedValue({ socialCampaignId: 'sc-9' }),
}));
import { provisionSocialFromCampaign } from '../../features/marketing/api/social-link.service';
import { CampaignSocialLinkButton } from './CampaignsPage';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
);

describe('CampaignSocialLinkButton', () => {
  beforeEach(() => { navigate.mockReset(); });
  it('provisions and navigates to the new social campaign', async () => {
    render(wrap(<CampaignSocialLinkButton campaignId="camp-1" />));
    fireEvent.click(screen.getByRole('button', { name: /social/i }));
    await waitFor(() => expect(provisionSocialFromCampaign).toHaveBeenCalledWith('camp-1'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-9'));
  });
});
