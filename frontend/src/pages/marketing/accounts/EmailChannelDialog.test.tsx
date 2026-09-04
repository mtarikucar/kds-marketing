import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmailChannelDialog } from './EmailChannelDialog';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { navigateExternal } from '../../../lib/navigateExternal';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../../lib/navigateExternal', () => ({ navigateExternal: vi.fn(() => true) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Interpolates, unlike the bare default-value mock used elsewhere — these
// strings name a provider, and asserting on a literal `{{provider}}` would pass
// while the person reads gibberish.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown, v?: Record<string, string>) => {
      const base = typeof d === 'string' ? d : k;
      return base.replace(/\{\{(\w+)\}\}/g, (_m, name) => v?.[name] ?? '');
    },
    i18n: { language: 'en' },
  }),
}));

const api = marketingApi as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

function wrap(providers: Array<{ provider: string; label: string }>) {
  api.get.mockResolvedValue({ data: { providers } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmailChannelDialog open onOpenChange={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );
}

const GOOGLE = [{ provider: 'GOOGLE', label: 'Google' }];

describe('EmailChannelDialog — consent first, password as the fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (navigateExternal as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('offers the consent button and keeps the password form folded away', async () => {
    wrap(GOOGLE);
    expect(await screen.findByRole('button', { name: /connect with google/i })).toBeInTheDocument();
    // Folded, not absent: Disclosure does not mount a closed section.
    expect(screen.getByText(/i have my own mail server/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/mailbox password/i)).not.toBeInTheDocument();
  });

  it('opens the password form when there is no consent path to offer', async () => {
    // With no app registration, custom SMTP is the ONLY way to connect a
    // mailbox — hiding it behind a fold would leave the dialog looking empty.
    wrap([]);
    expect(await screen.findByLabelText(/mailbox password/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
  });

  it('sends the person to the provider to consent', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } });
    wrap(GOOGLE);

    await user.click(await screen.findByRole('button', { name: /connect with google/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/channels/email/oauth/start', { provider: 'GOOGLE' }),
    );
    expect(navigateExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });

  describe('custom SMTP', () => {
    it('fills the server settings in from the address, so the form asks for two things', async () => {
      const user = userEvent.setup();
      api.post.mockResolvedValue({
        data: { smtp: { host: 'smtpout.secureserver.net', port: 587, secure: false, provider: 'GoDaddy' } },
      });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'admin@figurunica.com');
      await user.tab();

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/channels/email/oauth/smtp-suggest', {
          address: 'admin@figurunica.com',
        }),
      );
      await waitFor(() =>
        expect(screen.getByLabelText(/smtp host/i)).toHaveValue('smtpout.secureserver.net'),
      );
      expect(screen.getByLabelText(/smtp username/i)).toHaveValue('admin@figurunica.com');
      expect(screen.getByText(/recognised godaddy/i)).toBeInTheDocument();
    });

    it('says it does not know rather than filling in a guess', async () => {
      // A wrong host does not fail at connect time with a useful message; it
      // fails later, on a customer's send.
      const user = userEvent.setup();
      api.post.mockResolvedValue({ data: { smtp: null } });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'admin@tiny-host.example');
      await user.tab();

      expect(await screen.findByText(/don’t recognise this domain/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/smtp host/i)).toHaveValue('');
    });

    it('offers the passwordless path when the address turns out to be a Google one', async () => {
      // Nobody should type a Gmail password into this form while consent is one
      // click away.
      const user = userEvent.setup();
      api.post.mockResolvedValue({
        data: { smtp: { host: 'smtp.gmail.com', port: 587, secure: false, provider: 'Google', oauth: 'GOOGLE' } },
      });
      wrap(GOOGLE);

      await user.click(await screen.findByText(/i have my own mail server/i));
      await user.type(await screen.findByLabelText(/email address/i), 'someone@gmail.com');
      await user.tab();

      expect(await screen.findByText(/run by google — you can connect it without a password/i)).toBeInTheDocument();
    });

    it('does not offer consent for a provider this deployment cannot complete', async () => {
      const user = userEvent.setup();
      api.post.mockResolvedValue({
        data: { smtp: { host: 'smtp.gmail.com', port: 587, secure: false, provider: 'Google', oauth: 'GOOGLE' } },
      });
      wrap([]); // MX says Google, but no app registration exists here

      await user.type(await screen.findByLabelText(/email address/i), 'someone@gmail.com');
      await user.tab();

      await waitFor(() => expect(screen.getByLabelText(/smtp host/i)).toHaveValue('smtp.gmail.com'));
      expect(screen.queryByText(/without a password/i)).not.toBeInTheDocument();
    });

    it('does not overwrite a host the person corrected by hand', async () => {
      const user = userEvent.setup();
      api.post.mockResolvedValue({
        data: { smtp: { host: 'smtpout.secureserver.net', port: 587, secure: false, provider: 'GoDaddy' } },
      });
      wrap([]);

      await user.type(await screen.findByLabelText(/smtp host/i), 'mail.mycompany.internal');
      await user.type(screen.getByLabelText(/email address/i), 'admin@figurunica.com');
      await user.tab();

      await waitFor(() => expect(api.post).toHaveBeenCalled());
      expect(screen.getByLabelText(/smtp host/i)).toHaveValue('mail.mycompany.internal');
    });

    it('saves the address as the From, the username and the inbound identity', async () => {
      const user = userEvent.setup();
      api.post
        .mockResolvedValueOnce({
          data: { smtp: { host: 'smtpout.secureserver.net', port: 587, secure: false, provider: 'GoDaddy' } },
        })
        .mockResolvedValueOnce({ data: { id: 'ch1', webhookUrl: null, inboundSecretConfigured: false, inboundAddress: null } });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'Admin@Figurunica.com');
      await user.tab();
      await waitFor(() => expect(screen.getByLabelText(/smtp host/i)).toHaveValue('smtpout.secureserver.net'));
      await user.type(screen.getByLabelText(/mailbox password/i), 'hunter2');
      await user.click(screen.getByRole('button', { name: /^connect$/i }));

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/channels', expect.anything()));
      const body = api.post.mock.calls.find((c) => c[0] === '/channels')![1] as any;
      // Lower-cased on every field: Channel.externalId for EMAIL is stored
      // lower-cased and the inbound webhook lower-cases before resolving.
      expect(body.externalId).toBe('admin@figurunica.com');
      expect(body.secrets.fromEmail).toBe('admin@figurunica.com');
      expect(body.secrets.smtpUser).toBe('admin@figurunica.com');
      expect(body.secrets.smtpPass).toBe('hunter2');
    });

    it('will not submit without a server to send through', async () => {
      const user = userEvent.setup();
      api.post.mockResolvedValue({ data: { smtp: null } });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'admin@tiny-host.example');
      await user.type(screen.getByLabelText(/mailbox password/i), 'hunter2');

      expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
    });
  });
});
