import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { toast } from 'sonner';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import marketingApiModule from '../api/marketingApi';
import MarketingHeader from './MarketingHeader';

// P1T12 follow-up: PATCH /marketing/auth/profile 400s when an SMS-2FA-armed
// account changes `phone` without `currentPassword` (backend commit 6343d86,
// MarketingAuthService.updateProfile). These tests cover the UI that closes
// that dead-end: the password field only appears when it's actually needed,
// and a rejected password surfaces at the field, not a toast.
vi.mock('../api/marketingApi', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const marketingApi = vi.mocked(marketingApiModule, { deep: true }) as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

const USER: MarketingUser = {
  id: 'u1',
  workspaceId: 'w1',
  email: 'ada@x.io',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'OWNER',
  phone: '+905551112233',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function mockTwoFactorStatus(method: 'SMS' | 'TOTP' | null, enabled = true) {
  marketingApi.get.mockImplementation((url: string) => {
    if (url === '/auth/2fa/status') {
      return Promise.resolve({ data: { enabled, method } });
    }
    return Promise.resolve({ data: {} });
  });
}

async function renderHeaderAndOpenEditProfile() {
  useMarketingAuthStore.setState({
    user: USER,
    accessToken: 't',
    refreshToken: 'r',
    isAuthenticated: true,
  });
  useCommandPaletteStore.setState({ open: false });
  render(
    <MemoryRouter>
      <QueryClientProvider client={makeQC()}>
        <MarketingHeader />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText('Ada Lovelace'));
  await user.click(await screen.findByText(/edit profile/i));
  await screen.findByLabelText(/first name/i);
  return user;
}

describe('MarketingHeader — edit profile / phone + SMS-2FA currentPassword gate', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    marketingApi.get.mockReset();
    marketingApi.post.mockReset();
    marketingApi.patch.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('does not show a current-password field until the phone number is actually edited', async () => {
    mockTwoFactorStatus('SMS');
    await renderHeaderAndOpenEditProfile();

    expect(screen.queryByLabelText(/current password to change your phone number/i)).not.toBeInTheDocument();
  });

  it('reveals the current-password field once phone is dirty on an SMS-2FA-armed account', async () => {
    mockTwoFactorStatus('SMS');
    const user = await renderHeaderAndOpenEditProfile();

    const phoneInput = screen.getByPlaceholderText('+905XXXXXXXXX');
    await user.clear(phoneInput);
    await user.type(phoneInput, '+905559998877');

    expect(
      await screen.findByLabelText(/current password to change your phone number/i),
    ).toBeInTheDocument();
  });

  it('does NOT require a password for a phone change on a TOTP-armed account', async () => {
    mockTwoFactorStatus('TOTP');
    const user = await renderHeaderAndOpenEditProfile();

    const phoneInput = screen.getByPlaceholderText('+905XXXXXXXXX');
    await user.clear(phoneInput);
    await user.type(phoneInput, '+905559998877');

    // Give the 2FA-status query a tick to resolve before asserting absence.
    await waitFor(() => expect(marketingApi.get).toHaveBeenCalledWith('/auth/2fa/status'));
    expect(screen.queryByLabelText(/current password to change your phone number/i)).not.toBeInTheDocument();
  });

  it('blocks submit locally with a required-password message when the field is empty', async () => {
    mockTwoFactorStatus('SMS');
    const user = await renderHeaderAndOpenEditProfile();

    const phoneInput = screen.getByPlaceholderText('+905XXXXXXXXX');
    await user.clear(phoneInput);
    await user.type(phoneInput, '+905559998877');
    await screen.findByLabelText(/current password to change your phone number/i);

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/enter your current password to continue/i)).toBeInTheDocument();
    expect(marketingApi.patch).not.toHaveBeenCalled();
  });

  it('surfaces a backend "incorrect password" 400 next to the field, not as a toast', async () => {
    mockTwoFactorStatus('SMS');
    marketingApi.patch.mockRejectedValue({
      response: { status: 400, data: { message: 'Current password is incorrect' } },
    });
    const user = await renderHeaderAndOpenEditProfile();

    const phoneInput = screen.getByPlaceholderText('+905XXXXXXXXX');
    await user.clear(phoneInput);
    await user.type(phoneInput, '+905559998877');
    const passwordInput = await screen.findByLabelText(/current password to change your phone number/i);
    await user.type(passwordInput, 'wrong-password');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(marketingApi.patch).toHaveBeenCalledWith(
      '/auth/profile',
      expect.objectContaining({ currentPassword: 'wrong-password' }),
    );
  });

  it('submits without currentPassword when the phone is untouched', async () => {
    mockTwoFactorStatus('SMS');
    marketingApi.patch.mockResolvedValue({
      data: { firstName: 'Ada', lastName: 'Byron', phone: USER.phone },
    });
    const user = await renderHeaderAndOpenEditProfile();

    const lastNameInput = screen.getByLabelText(/last name/i);
    await user.clear(lastNameInput);
    await user.type(lastNameInput, 'Byron');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(marketingApi.patch).toHaveBeenCalled());
    const [, payload] = marketingApi.patch.mock.calls[0];
    expect(payload).not.toHaveProperty('currentPassword');
    expect(toast.success).toHaveBeenCalled();
  });
});
