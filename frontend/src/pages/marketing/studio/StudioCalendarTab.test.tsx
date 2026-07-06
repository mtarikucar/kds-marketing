import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import StudioCalendarTab from './StudioCalendarTab';
import * as campaigns from '../../../features/marketing/api/socialCampaigns.service';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: string | Record<string, unknown>) =>
      typeof o === 'string' ? o : ((o?.defaultValue as string) ?? k),
  }),
}));
vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
  createSocialCampaign: vi.fn(),
}));
vi.mock('../../../features/marketing/api/contentCalendar.service', () => ({
  listContentCalendar: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({
      data: [
        { id: 'acc-1', network: 'INSTAGRAM' },
        { id: 'acc-2', network: 'FACEBOOK' },
      ],
    }),
  },
}));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StudioCalendarTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The old WeeklyPlan dialog died in the 2026-07 trim (its Approve button never
// published anything). The CTA now provisions a REAL one-week SocialCampaign
// (APPROVAL + AI_PROPOSE) and lands the user on its review screen.
describe('StudioCalendarTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('provisions a one-week APPROVAL+AI_PROPOSE campaign targeting the connected accounts and navigates to it', async () => {
    (campaigns.createSocialCampaign as any).mockResolvedValue({ id: 'sc-9' });
    renderTab();

    fireEvent.click(await screen.findByText('Generate weekly plan'));

    await waitFor(() => expect(campaigns.createSocialCampaign).toHaveBeenCalledTimes(1));
    const payload = (campaigns.createSocialCampaign as any).mock.calls[0][0];
    expect(payload).toMatchObject({
      automationMode: 'APPROVAL', // AI drafts, the user approves — only then it publishes
      planningMode: 'AI_PROPOSE',
      mediaKinds: ['IMAGE'],
      targetAccountIds: ['acc-1', 'acc-2'],
    });
    // One week exactly.
    const spanDays =
      (new Date(payload.endDate).getTime() - new Date(payload.startDate).getTime()) / 86_400_000;
    expect(spanDays).toBeCloseTo(7, 5);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-9'));
  });
});
