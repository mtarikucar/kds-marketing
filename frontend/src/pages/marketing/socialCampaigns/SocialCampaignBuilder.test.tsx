import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const createSocialCampaign = vi.fn();
const navigate = vi.fn();
const apiGet = vi.fn();
vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
  createSocialCampaign: (...a: unknown[]) => createSocialCampaign(...a),
}));
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => apiGet(...a) },
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SocialCampaignBuilder from './SocialCampaignBuilder';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ACCOUNTS = [
  {
    id: 'acc-fb',
    network: 'FACEBOOK',
    externalId: 'fb-1',
    displayName: 'Acme Facebook',
    accessToken: '••••abcd',
    tokenExpiresAt: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'acc-ig',
    network: 'INSTAGRAM',
    externalId: 'ig-1',
    displayName: 'Acme Instagram',
    accessToken: '••••wxyz',
    tokenExpiresAt: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('SocialCampaignBuilder', () => {
  beforeEach(() => {
    createSocialCampaign.mockReset();
    navigate.mockReset();
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: [] });
  });

  it('walks every step and submits a full payload on Review', async () => {
    createSocialCampaign.mockResolvedValue({ id: 'sc-new' });
    const user = userEvent.setup();
    render(<SocialCampaignBuilder />, { wrapper });

    // Step 1 — Goal & theme
    await user.type(screen.getByLabelText('Name'), 'Q3 Push');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2 — Brief & Brand Kit
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3 — Channels & cadence
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 4 — Automation mode
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 5 — Planning mode
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 6 — Review → Create
    await user.click(screen.getByRole('button', { name: 'Create campaign' }));

    expect(createSocialCampaign).toHaveBeenCalledTimes(1);
    const payload = createSocialCampaign.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'Q3 Push',
      automationMode: 'APPROVAL',
      planningMode: 'AI_PROPOSE',
      mediaKinds: ['IMAGE'],
    });
    expect(payload.cadence).toMatchObject({ perWeek: expect.any(Number) });
    expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-new');
  });

  it('blocks advancing past step 1 without a name', async () => {
    const user = userEvent.setup();
    render(<SocialCampaignBuilder />, { wrapper });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // still on step 1 — the Name field is present, Review's submit is not
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create campaign' })).not.toBeInTheDocument();
  });

  it('renders connected accounts and submits the selected targetAccountIds', async () => {
    apiGet.mockResolvedValue({ data: ACCOUNTS });
    createSocialCampaign.mockResolvedValue({ id: 'sc-new' });
    const user = userEvent.setup();
    render(<SocialCampaignBuilder />, { wrapper });

    // Step 1 — Goal & theme
    await user.type(screen.getByLabelText('Name'), 'Q3 Push');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2 — Brief & Brand Kit
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3 — Channels & cadence: the fetched accounts render, pick one.
    expect(await screen.findByText('Acme Facebook')).toBeInTheDocument();
    expect(screen.getByText('Acme Instagram')).toBeInTheDocument();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    await user.click(checkboxes[0]);

    // Steps 4–6 (Automation → Planning → Review) then Create.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create campaign' }));

    expect(createSocialCampaign).toHaveBeenCalledTimes(1);
    const payload = createSocialCampaign.mock.calls[0][0];
    expect(payload.targetAccountIds).toEqual(['acc-fb']);
    expect(apiGet).toHaveBeenCalledWith('/social-planner/accounts');
  });

  it('blocks automated modes until a target account is selected', async () => {
    apiGet.mockResolvedValue({ data: ACCOUNTS });
    const user = userEvent.setup();
    render(<SocialCampaignBuilder />, { wrapper });

    await user.type(screen.getByLabelText('Name'), 'Auto Push');
    await user.click(screen.getByRole('button', { name: 'Next' })); // → Brief
    await user.click(screen.getByRole('button', { name: 'Next' })); // → Channels
    await screen.findByText('Acme Facebook'); // accounts loaded, none picked
    await user.click(screen.getByRole('button', { name: 'Next' })); // → Automation

    // Choose FULL_AUTO with no target account → Next is blocked and an alert shows.
    await user.click(screen.getByLabelText('FULL_AUTO'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
