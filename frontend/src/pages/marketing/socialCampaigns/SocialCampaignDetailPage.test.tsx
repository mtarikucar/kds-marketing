import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type {
  SocialCampaign,
  SocialCampaignItem,
} from '../../../features/marketing/api/socialCampaigns.service';

const getSocialCampaign = vi.fn();
const listSocialCampaignItems = vi.fn();
const confirmSocialCampaignPlan = vi.fn();
vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
  getSocialCampaign: (...a: unknown[]) => getSocialCampaign(...a),
  listSocialCampaignItems: (...a: unknown[]) => listSocialCampaignItems(...a),
  confirmSocialCampaignPlan: (...a: unknown[]) => confirmSocialCampaignPlan(...a),
  reviewSocialCampaignItem: vi.fn(),
  setCampaignLifecycle: vi.fn(),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'sc1' }) };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SocialCampaignDetailPage from './SocialCampaignDetailPage';

const campaign = (over: Partial<SocialCampaign> = {}): SocialCampaign => ({
  id: 'sc1', name: 'Q3 Push', goal: null, theme: null, brief: {},
  status: 'DRAFT', automationMode: 'APPROVAL', planningMode: 'AI_PROPOSE',
  cadence: { perWeek: 3, daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'UTC' },
  startDate: '2026-07-01', endDate: null, targetAccountIds: [], mediaKinds: ['IMAGE'],
  dailyPublishCap: 1, linkedCampaignId: null, linkedAdCampaignId: null, stats: null,
  createdAt: '', updatedAt: '', ...over,
});

const item = (over: Partial<SocialCampaignItem> = {}): SocialCampaignItem => ({
  id: 'it', socialCampaignId: 'sc1', sequenceIndex: 0, scheduledFor: '2026-07-01T09:00:00.000Z',
  status: 'PLANNED', topic: 'Draft post', socialPostId: null, generatedAssetIds: [],
  error: null, createdAt: '', updatedAt: '', ...over,
});

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, wrapper };
}

describe('SocialCampaignDetailPage', () => {
  beforeEach(() => {
    getSocialCampaign.mockReset();
    listSocialCampaignItems.mockReset();
    confirmSocialCampaignPlan.mockReset();
  });

  it('shows Confirm plan for AI_PROPOSE campaigns with PLANNED items, fires the mutation and invalidates', async () => {
    getSocialCampaign.mockResolvedValue(campaign({ planningMode: 'AI_PROPOSE' }));
    listSocialCampaignItems.mockResolvedValue([item({ status: 'PLANNED' })]);
    confirmSocialCampaignPlan.mockResolvedValue({ message: 'ok' });
    const user = userEvent.setup();
    const { qc, wrapper } = makeWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(<SocialCampaignDetailPage />, { wrapper });

    const confirm = await screen.findByRole('button', { name: 'Confirm plan' });
    await user.click(confirm);

    await waitFor(() => expect(confirmSocialCampaignPlan).toHaveBeenCalledWith('sc1'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['marketing', 'social-campaigns', 'sc1', 'items'],
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['marketing', 'social-campaigns', 'sc1'],
    });
  });

  it('hides Confirm plan when the planning mode is not AI_PROPOSE', async () => {
    getSocialCampaign.mockResolvedValue(campaign({ planningMode: 'AI_FULL' }));
    listSocialCampaignItems.mockResolvedValue([item({ status: 'PLANNED' })]);
    render(<SocialCampaignDetailPage />, { wrapper: makeWrapper().wrapper });

    await screen.findByText('Q3 Push');
    expect(screen.queryByRole('button', { name: 'Confirm plan' })).not.toBeInTheDocument();
  });

  it('hides Confirm plan when no items are awaiting confirmation', async () => {
    getSocialCampaign.mockResolvedValue(campaign({ planningMode: 'AI_PROPOSE' }));
    listSocialCampaignItems.mockResolvedValue([item({ status: 'PUBLISHED' })]);
    render(<SocialCampaignDetailPage />, { wrapper: makeWrapper().wrapper });

    await screen.findByText('Q3 Push');
    expect(screen.queryByRole('button', { name: 'Confirm plan' })).not.toBeInTheDocument();
  });
});
