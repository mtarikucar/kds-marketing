import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmailChannelDialog } from './EmailChannelDialog';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { navigateExternal } from '../../../lib/navigateExternal';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
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

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

function wrap(
  providers: Array<{ provider: string; label: string }>,
  channel?: Parameters<typeof EmailChannelDialog>[0]['channel'],
) {
  api.get.mockResolvedValue({ data: { providers } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmailChannelDialog open onOpenChange={() => {}} onCreated={() => {}} channel={channel} />
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

    it('fills the IMAP server in from the recognised provider', async () => {
      // The MX table already knows the INCOMING server for every provider it
      // recognises, and the poller derives it again at read time — but the form
      // never showed it, so nobody could see or correct where their mailbox
      // would actually be polled.
      const user = userEvent.setup();
      api.post.mockResolvedValue({
        data: {
          smtp: {
            host: 'smtpout.secureserver.net',
            port: 587,
            secure: false,
            provider: 'GoDaddy',
            imap: { host: 'imap.secureserver.net', port: 993 },
          },
        },
      });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'admin@figurunica.com');
      await user.tab();

      await waitFor(() =>
        expect(screen.getByLabelText(/imap host/i)).toHaveValue('imap.secureserver.net'),
      );
      expect(screen.getByLabelText(/imap port/i)).toHaveValue('993');
    });

    it('carries a hand-typed IMAP server so an unrecognised mailbox can still receive', async () => {
      // imapForSmtpHost() answers null for a provider the table does not know,
      // and email-imap-poll then skips that mailbox entirely. With nowhere to
      // say where its IMAP lives, a self-hosted mailbox could send and never
      // receive — the half of "two-way email" that quietly went missing.
      const user = userEvent.setup();
      api.post
        .mockResolvedValueOnce({ data: { smtp: null } })
        .mockResolvedValueOnce({
          data: { id: 'ch1', webhookUrl: null, inboundSecretConfigured: false, inboundAddress: null },
        });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'admin@tiny-host.example');
      await user.tab();
      await user.type(screen.getByLabelText(/smtp host/i), 'mail.tiny-host.example');
      await user.type(screen.getByLabelText(/mailbox password/i), 'hunter2');
      await user.type(screen.getByLabelText(/imap host/i), 'imap.tiny-host.example');
      await user.clear(screen.getByLabelText(/imap port/i));
      await user.type(screen.getByLabelText(/imap port/i), '143');
      await user.click(screen.getByRole('button', { name: /^connect$/i }));

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/channels', expect.anything()));
      const body = api.post.mock.calls.find((c) => c[0] === '/channels')![1] as any;
      expect(body.secrets.imapHost).toBe('imap.tiny-host.example');
      expect(body.secrets.imapPort).toBe('143');
    });

    it('omits the IMAP keys entirely when they are left blank', async () => {
      // Sealing an empty string would sit in the secrets looking like a
      // configured override, and `imapHost?.trim()` would read it as one.
      // Leaving the keys out keeps autodiscovery in charge, which is the right
      // default for every provider the table already knows.
      const user = userEvent.setup();
      api.post
        .mockResolvedValueOnce({
          data: { smtp: { host: 'mail.x.example', port: 587, secure: false, provider: 'X' } },
        })
        .mockResolvedValueOnce({
          data: { id: 'ch1', webhookUrl: null, inboundSecretConfigured: false, inboundAddress: null },
        });
      wrap([]);

      await user.type(await screen.findByLabelText(/email address/i), 'admin@x.example');
      await user.tab();
      await waitFor(() => expect(screen.getByLabelText(/smtp host/i)).toHaveValue('mail.x.example'));
      await user.type(screen.getByLabelText(/mailbox password/i), 'hunter2');
      await user.click(screen.getByRole('button', { name: /^connect$/i }));

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/channels', expect.anything()));
      const body = api.post.mock.calls.find((c) => c[0] === '/channels')![1] as any;
      expect(body.secrets).not.toHaveProperty('imapHost');
      expect(body.secrets).not.toHaveProperty('imapPort');
    });
  });
});

/**
 * EDITING A MAILBOX, which used to mean deleting it.
 *
 * A password change had exactly one path through this product: delete the
 * channel and connect it again. `remove()` hard-deletes, so every conversation
 * and contact identity hanging off that channel was orphaned — old threads
 * 404, and the customer's next reply opens a duplicate conversation. The whole
 * point of this mode is that the CHANNEL ROW SURVIVES.
 */
describe('EmailChannelDialog — editing an existing mailbox', () => {
  const CHANNEL = {
    id: 'ch1',
    address: 'destek@acme.com',
    configuredSecrets: ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'fromEmail'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (navigateExternal as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('locks the address, because it is the inbound routing key', async () => {
    // externalId is what inbound mail is matched on and `fromEmail` is what
    // outbound is sent as. Letting Edit change one silently would leave the
    // mailbox sending from one address and receiving at another.
    wrap([], CHANNEL);
    const address = await screen.findByLabelText(/email address/i);
    expect(address).toHaveValue('destek@acme.com');
    expect(address).toBeDisabled();
  });

  it('patches the new password onto the SAME channel and re-verifies it', async () => {
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ data: { id: 'ch1' } });
    api.post.mockResolvedValue({ data: { ok: true } });
    wrap([], CHANNEL);

    await user.type(await screen.findByLabelText(/mailbox password/i), 'new-hunter2');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/channels/ch1', expect.anything()));
    const body = api.patch.mock.calls[0][1] as any;
    expect(body.secrets.smtpPass).toBe('new-hunter2');
    // Never a create, and never a re-registration of the identity: both are
    // how the threads got orphaned.
    expect(api.post).not.toHaveBeenCalledWith('/channels', expect.anything());
    expect(body).not.toHaveProperty('externalId');
    expect(body).not.toHaveProperty('type');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/channels/ch1/verify'));
  });

  it('clears the consent keys when a password is set, or the password is ignored', async () => {
    // EmailChannelAdapter checks `oauthProvider` FIRST and never looks at the
    // SMTP block again, so a password patched onto a channel that still
    // carries stale oauth* keys does nothing at all — and Edit looks broken.
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ data: { id: 'ch1' } });
    api.post.mockResolvedValue({ data: { ok: true } });
    wrap([], { ...CHANNEL, consent: true, configuredSecrets: ['oauthProvider', 'oauthAccessToken'] });

    await user.type(await screen.findByLabelText(/mailbox password/i), 'new-hunter2');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const body = api.patch.mock.calls[0][1] as any;
    expect(body.clearSecretKeys).toEqual(
      expect.arrayContaining(['oauthProvider', 'oauthAccessToken', 'oauthRefreshToken', 'oauthExpiresAt']),
    );
  });

  it('leaves a consent mailbox alone when only its IMAP host is corrected', async () => {
    // The mirror of the rule above: clearing the grant because somebody fixed
    // where replies are read from would take the mailbox's ability to SEND
    // with it.
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ data: { id: 'ch1' } });
    api.post.mockResolvedValue({ data: { ok: true } });
    wrap([], { ...CHANNEL, consent: true, configuredSecrets: ['oauthProvider', 'oauthAccessToken'] });

    await user.type(await screen.findByLabelText(/imap host/i), 'imap.acme.com');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const body = api.patch.mock.calls[0][1] as any;
    expect(body.secrets).toEqual({ imapHost: 'imap.acme.com' });
    expect(body.clearSecretKeys).toBeUndefined();
  });

  it('sends nothing for a field left blank, so a partial edit keeps the rest', async () => {
    // ChannelsService.update MERGES partial secrets. Blank therefore means
    // "unchanged", and posting an empty string would seal a credential that
    // looks configured and is not.
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ data: { id: 'ch1' } });
    api.post.mockResolvedValue({ data: { ok: true } });
    wrap([], CHANNEL);

    await user.type(await screen.findByLabelText(/mailbox password/i), 'new-hunter2');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect((api.patch.mock.calls[0][1] as any).secrets).toEqual({ smtpPass: 'new-hunter2' });
  });

  it('will not submit an edit that changes nothing', async () => {
    wrap([], CHANNEL);
    expect(await screen.findByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('names what the mailbox already holds, so a blank field does not read as missing', async () => {
    wrap([], CHANNEL);
    expect(await screen.findByText(/smtpHost, smtpPort, smtpUser/)).toBeInTheDocument();
  });

  it('opens on the consent buttons when the grant is what died', async () => {
    // A revoked Google consent is not a password problem, and the fix is one
    // click at the provider — not five fields.
    wrap(GOOGLE, { ...CHANNEL, consent: true, reauthRequired: true });
    expect(await screen.findByRole('button', { name: /connect with google/i })).toBeInTheDocument();
    expect(screen.getByText(/connection needs renewing/i)).toBeInTheDocument();
  });
});
