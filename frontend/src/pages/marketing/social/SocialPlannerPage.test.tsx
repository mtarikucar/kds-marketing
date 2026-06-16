import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SocialPlannerPage from './SocialPlannerPage';

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

const STATUS = { FACEBOOK: true, INSTAGRAM: true, LINKEDIN: true, secretBoxConfigured: true };

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
});
