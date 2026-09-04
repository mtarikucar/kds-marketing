import { BadRequestException } from '@nestjs/common';
import { EmailOAuthService } from './email-oauth.service';
import { verifyState } from '../social-planner/oauth/social-oauth-state.util';
import { isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { exchangeCodeForTokens, fetchConnectedAddress } from './email-oauth.sender';

// Module mocks, not namespace spies: the SWC transform defines exports as
// non-configurable getters, so jest.spyOn on a module object cannot bind.
jest.mock('../social-planner/oauth/social-oauth-state.util', () => ({
  ...jest.requireActual('../social-planner/oauth/social-oauth-state.util'),
  signState: jest.fn(() => 'signed-state'),
  verifyState: jest.fn(),
}));
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  ...jest.requireActual('../../../common/crypto/secret-box.helper'),
  isSecretBoxConfigured: jest.fn(() => true),
}));
jest.mock('./email-oauth.sender', () => ({
  ...jest.requireActual('./email-oauth.sender'),
  exchangeCodeForTokens: jest.fn(),
  fetchConnectedAddress: jest.fn(),
}));

const verifyStateMock = verifyState as unknown as jest.Mock;
const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
const exchangeMock = exchangeCodeForTokens as unknown as jest.Mock;
const addressMock = fetchConnectedAddress as unknown as jest.Mock;

const WS = 'ws-1';
const ADDRESS = 'admin@figurunica.com';
const GOOD_TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_700_000_000_000, error: null };

describe('connecting a mailbox by consent', () => {
  let prisma: any;
  let channels: any;
  let svc: EmailOAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    isSecretBoxConfiguredMock.mockReturnValue(true);
    process.env.GOOGLE_MAIL_CLIENT_ID = 'id';
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
    process.env.PUBLIC_BASE_URL = 'https://app.example.com';
    prisma = { channel: { findFirst: jest.fn().mockResolvedValue(null) } };
    channels = {
      create: jest.fn().mockResolvedValue({ id: 'ch-new' }),
      update: jest.fn().mockResolvedValue({ id: 'ch-old' }),
    };
    svc = new EmailOAuthService(prisma, channels);
  });

  afterEach(() => {
    delete process.env.GOOGLE_MAIL_CLIENT_ID;
    delete process.env.GOOGLE_MAIL_CLIENT_SECRET;
    delete process.env.MICROSOFT_MAIL_CLIENT_ID;
    delete process.env.MICROSOFT_MAIL_CLIENT_SECRET;
  });

  describe('providers', () => {
    it('offers only what this deployment can complete', () => {
      // A button that redirects with an empty client_id fails on the provider's
      // own error page, where we cannot explain anything.
      expect(svc.providers().map((p) => p.provider)).toEqual(['GOOGLE']);
      delete process.env.GOOGLE_MAIL_CLIENT_ID;
      expect(svc.providers()).toEqual([]);
    });
  });

  describe('start', () => {
    it('refuses a provider we do not implement', () => {
      expect(() => svc.start(WS, 'YAHOO')).toThrow(BadRequestException);
    });

    it('refuses when the app is not registered, instead of a dead-end redirect', () => {
      delete process.env.GOOGLE_MAIL_CLIENT_ID;
      expect(() => svc.start(WS, 'GOOGLE')).toThrow(/not configured/i);
    });

    it('refuses when there is nowhere safe to put the token', () => {
      isSecretBoxConfiguredMock.mockReturnValue(false);
      expect(() => svc.start(WS, 'GOOGLE')).toThrow(/MARKETING_SECRET_KEY/);
    });
  });

  describe('callback', () => {
    it('rejects a state minted for the social flow', async () => {
      // Both flows sign with the same key, so only the network tag stops a
      // social state being spent here (and the reverse).
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'instagram' });
      await expect(svc.handleCallback('code', 's')).rejects.toThrow(/Invalid or expired/);
      expect(exchangeMock).not.toHaveBeenCalled();
    });

    it('rejects an unverifiable state', async () => {
      verifyStateMock.mockReturnValue(null);
      await expect(svc.handleCallback('code', 's')).rejects.toThrow(/Invalid or expired/);
    });

    it('surfaces the exchange failure rather than connecting a half-made channel', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue({
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        error: 'GOOGLE did not return a refresh token',
      });
      await expect(svc.handleCallback('code', 's')).rejects.toThrow(/did not return a refresh token/);
      expect(channels.create).not.toHaveBeenCalled();
    });

    it('refuses when the mailbox will not say its own address', async () => {
      // Without it there is no From header and no way to tell which channel
      // this consent belongs to.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(null);
      await expect(svc.handleCallback('code', 's')).rejects.toThrow(/address of the connected mailbox/);
      expect(channels.create).not.toHaveBeenCalled();
    });

    it('creates a channel named by the mailbox it connected', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);

      const r = await svc.handleCallback('code', 's');

      expect(r).toEqual({ channelId: 'ch-new', address: ADDRESS });
      expect(channels.create).toHaveBeenCalledWith(WS, {
        type: 'EMAIL',
        name: ADDRESS,
        externalId: ADDRESS,
        secrets: {
          oauthProvider: 'GOOGLE',
          oauthAccessToken: 'at',
          oauthRefreshToken: 'rt',
          oauthExpiresAt: '1700000000000',
          fromEmail: ADDRESS,
        },
      });
    });

    it('reconnects the mailbox it already has, rather than colliding with itself', async () => {
      // externalId is unique per (type, address) ACROSS workspaces, so creating
      // a second row for the same mailbox throws a conflict that reads as
      // "someone else has this address" to the person who owns it.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      prisma.channel.findFirst.mockResolvedValue({ id: 'ch-old' });

      const r = await svc.handleCallback('code', 's');

      expect(r.channelId).toBe('ch-old');
      expect(channels.create).not.toHaveBeenCalled();
      const [, id, patch] = channels.update.mock.calls[0];
      expect(id).toBe('ch-old');
      expect(patch.status).toBe('ACTIVE');
      expect(patch.secrets.oauthProvider).toBe('GOOGLE');
    });

    it('clears the SMTP password when the same channel switches to consent', async () => {
      // secrets MERGE, so without this the old password stays sealed beside a
      // live token — a credential nobody is watching any more.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      prisma.channel.findFirst.mockResolvedValue({ id: 'ch-old' });

      await svc.handleCallback('code', 's');

      expect(channels.update.mock.calls[0][2].clearSecretKeys).toEqual(
        expect.arrayContaining(['smtpHost', 'smtpUser', 'smtpPass']),
      );
    });

    it('looks the channel up inside the state workspace only', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      await svc.handleCallback('code', 's');
      expect(prisma.channel.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: WS, type: 'EMAIL', externalId: ADDRESS },
      });
    });
  });
});
