import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import ChannelsSettingsPage from './ChannelsSettingsPage';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// The OAuth "start" does a full-page redirect — stub it so jsdom doesn't navigate.
vi.mock('../../lib/navigateExternal', () => ({ navigateExternal: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

  // Connecting a channel now lives in the Account Center; this page is
  // management-only, so it links there instead of opening an inline create dialog.
  it('links to the Account Center to connect a channel', async () => {
    render(<ChannelsSettingsPage />, { wrapper });
    const links = await screen.findAllByRole('link', { name: /account center/i });
    expect(links[0]).toHaveAttribute('href', '/accounts');
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

  it('shows per-channel management (Verify) for an existing channel', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
    marketingApi.get.mockImplementation((url: string) =>
      url === '/channels'
        ? Promise.resolve({
            data: [
              { id: 'ch1', type: 'SMS', name: 'SMS line', status: 'ACTIVE', configuredSecrets: ['usercode'], configPublic: {}, agentProfileId: null },
            ],
          })
        : Promise.resolve({ data: [] }),
    );
    render(<ChannelsSettingsPage />, { wrapper });
    expect(await screen.findByText('SMS line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
  });

  /**
   * Verify failure headline splits by WHY it failed (NetGSM SMS healthCheck):
   * a rejected credential, an unreachable provider, and an approved-header
   * miss are three different operator actions, so they must not collapse
   * into one generic "check credentials" toast.
   */
  describe('verify failure headline split', () => {
    async function renderAndVerify(verifyResponse: unknown) {
      const marketingApi = (await import('../../features/marketing/api/marketingApi')).default as any;
      marketingApi.get.mockImplementation((url: string) =>
        url === '/channels'
          ? Promise.resolve({
              data: [
                { id: 'ch1', type: 'SMS', name: 'SMS line', status: 'ACTIVE', configuredSecrets: ['usercode'], configPublic: {}, agentProfileId: null },
              ],
            })
          : Promise.resolve({ data: [] }),
      );
      marketingApi.post.mockResolvedValue({ data: verifyResponse });
      render(<ChannelsSettingsPage />, { wrapper });
      await screen.findByText('SMS line');
      await userEvent.click(screen.getByRole('button', { name: /verify/i }));
    }

    it('credsValid: false → the "check credentials" headline', async () => {
      await renderAndVerify({ ok: false, details: { credsValid: false, message: 'Kimlik doğrulama hatası' } });
      expect(toast.error).toHaveBeenCalledWith(
        'Verification failed — check credentials',
        expect.objectContaining({ description: 'Kimlik doğrulama hatası' }),
      );
    });

    it('credsValid: null (unreachable) → the "could not reach" headline, distinct from bad creds', async () => {
      await renderAndVerify({ ok: false, details: { credsValid: null, message: 'NetGSM erişilemedi' } });
      expect(toast.error).toHaveBeenCalledWith(
        'Could not reach NetGSM — try again',
        expect.objectContaining({ description: 'NetGSM erişilemedi' }),
      );
    });

    it('credsValid: undefined (unreachable, absent) → the "could not reach" headline', async () => {
      await renderAndVerify({ ok: false, details: { message: 'timeout' } });
      expect(toast.error).toHaveBeenCalledWith(
        'Could not reach NetGSM — try again',
        expect.objectContaining({ description: 'timeout' }),
      );
    });

    it('headerApproved: false → the sender-ID-not-approved headline, even though creds are valid', async () => {
      await renderAndVerify({
        ok: false,
        details: { credsValid: true, headerApproved: false, approvedHeaders: ['OTHERHDR'], message: null },
      });
      expect(toast.error).toHaveBeenCalledWith('Sender ID is not approved on this account', undefined);
    });

    it('ok: true → the verified headline (success toast, not error)', async () => {
      await renderAndVerify({ ok: true, details: { credsValid: true, headerApproved: true } });
      expect(toast.success).toHaveBeenCalledWith('Channel verified ✓', undefined);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
