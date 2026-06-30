import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SocialPlannerPage from './SocialPlannerPage';
import * as socialPlannerService from '../../../features/marketing/api/social-planner.service';

const ACCOUNT = {
  id: 'acc-1',
  network: 'FACEBOOK',
  externalId: '123',
  displayName: 'Acme Page',
  accessToken: '••••wxyz',
  tokenExpiresAt: null,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const TIKTOK_ACCOUNT = {
  id: 'acc-tiktok-1',
  network: 'TIKTOK',
  externalId: 'tiktok-ext-1',
  displayName: 'My TikTok',
  accessToken: '••••tiktok',
  tokenExpiresAt: null,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const TIKTOK_CREATOR_INFO = {
  privacyLevelOptions: ['SELF_ONLY'],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
  maxVideoPostDurationSec: 60,
};

const STATUS = { FACEBOOK: true, INSTAGRAM: true, LINKEDIN: true, TIKTOK: true, secretBoxConfigured: true };

// Route GET responses by URL so accounts/status/posts each return the right shape.
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.includes('/status')) return Promise.resolve({ data: STATUS });
      if (url.includes('/accounts')) return Promise.resolve({ data: [ACCOUNT] });
      if (url.includes('/posts')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn().mockResolvedValue({ data: { id: 'post-1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../../features/marketing/api/social-planner.service', () => ({
  getTiktokCreatorInfo: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getMockGet = async () => ((await import('../../../features/marketing/api/marketingApi')) as any).default.get as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SocialPlannerPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<SocialPlannerPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the posts/accounts view toggle', () => {
    render(<SocialPlannerPage />, { wrapper });
    expect(screen.getByRole('group', { name: /social planner view/i })).toBeInTheDocument();
  });

  it('opens the composer and validates an empty post', async () => {
    render(<SocialPlannerPage />, { wrapper });

    // Wait for the accounts query to resolve so the "New post" button enables.
    const newBtn = await screen.findByRole('button', { name: /new post/i });
    // The header button is enabled once accounts load.
    expect(newBtn).toBeEnabled();
    await userEvent.click(newBtn);

    // Composer dialog opens (a level-2 heading).
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();

    // Select the one available target account so the submit button enables.
    const checkbox = await screen.findByRole('checkbox');
    await userEvent.click(checkbox);

    // Submit with empty content → a validation alert appears.
    const submitBtn = screen.getByRole('button', { name: /create post/i });
    await userEvent.click(submitBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  describe('TikTok composer controls', () => {
    beforeEach(async () => {
      // Override accounts endpoint to return a TikTok account for this test group.
      const mockGet = await getMockGet();
      mockGet.mockImplementation((url: string) => {
        if (url.includes('/status')) return Promise.resolve({ data: STATUS });
        if (url.includes('/accounts')) return Promise.resolve({ data: [TIKTOK_ACCOUNT] });
        if (url.includes('/posts')) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: [] });
      });
      // Resolve creator-info for the TikTok account.
      vi.mocked(socialPlannerService.getTiktokCreatorInfo).mockResolvedValue(TIKTOK_CREATOR_INFO);
    });

    it('renders TikTok composer controls with creator-info data', async () => {
      render(<SocialPlannerPage />, { wrapper });

      // Open composer.
      const newBtn = await screen.findByRole('button', { name: /new post/i });
      await userEvent.click(newBtn);
      expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();

      // Select the TikTok account checkbox.
      const checkbox = await screen.findByRole('checkbox');
      await userEvent.click(checkbox);

      // (a) TikTok controls panel appears; privacy select shows "Only me" (the sole SELF_ONLY option).
      await screen.findByTestId('tiktok-controls');
      // The Select trigger displays the selected value — SELF_ONLY maps to "Only me".
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /privacy/i })).toBeInTheDocument();
      });
      // Verify the trigger text shows the only available option label.
      expect(screen.getByRole('combobox', { name: /privacy/i }).textContent).toMatch(/only me/i);

      // (b) Duet toggle is disabled because duetDisabled=true in creator-info.
      const duetSwitch = await screen.findByRole('switch', { name: /disable duet/i });
      expect(duetSwitch).toBeDisabled();

      // (c) Switching to photo mode reveals the cover-index field.
      // Add two media URLs first so the cover-index field becomes visible (it requires >1 URL).
      const addUrlBtn = screen.getByRole('button', { name: /add url/i });
      await userEvent.click(addUrlBtn);
      await userEvent.click(addUrlBtn);
      // Click the photo/video mode switch.
      const photoSwitch = screen.getByRole('switch', { name: /switch to photo/i });
      await userEvent.click(photoSwitch);
      expect(await screen.findByRole('spinbutton', { name: /cover image index/i })).toBeInTheDocument();

      // (d) The max-video-length info line renders "60".
      const maxDurationEl = await screen.findByTestId('tiktok-max-duration');
      expect(maxDurationEl.textContent).toContain('60');
    });
  });
});
