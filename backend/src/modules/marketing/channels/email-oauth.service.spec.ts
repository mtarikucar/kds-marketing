import { BadRequestException } from '@nestjs/common';
import { EmailOAuthService } from './email-oauth.service';
import { verifyState } from '../social-planner/oauth/social-oauth-state.util';
import { isSecretBoxConfigured, openSecret } from '../../../common/crypto/secret-box.helper';
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
  openSecret: jest.fn(() => '{}'),
}));
jest.mock('./email-oauth.sender', () => ({
  ...jest.requireActual('./email-oauth.sender'),
  exchangeCodeForTokens: jest.fn(),
  fetchConnectedAddress: jest.fn(),
}));

const verifyStateMock = verifyState as unknown as jest.Mock;
const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
const openSecretMock = openSecret as unknown as jest.Mock;
const exchangeMock = exchangeCodeForTokens as unknown as jest.Mock;
const addressMock = fetchConnectedAddress as unknown as jest.Mock;

const WS = 'ws-1';
const ADDRESS = 'admin@figurunica.com';
const GOOD_TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_700_000_000_000, error: null };

describe('connecting a mailbox by consent', () => {
  let prisma: any;
  let channels: any;
  let health: any;
  let svc: EmailOAuthService;

  /** What the channel being reconnected already holds, sealed. */
  const sealedAs = (secrets: Record<string, string>) => {
    prisma.channel.findFirst.mockResolvedValue({ id: 'ch-old', configSealed: 'box' });
    openSecretMock.mockReturnValue(JSON.stringify(secrets));
  };
  const clearedOnReconnect = (): string[] => channels.update.mock.calls[0][2].clearSecretKeys;

  beforeEach(() => {
    jest.clearAllMocks();
    isSecretBoxConfiguredMock.mockReturnValue(true);
    openSecretMock.mockReturnValue('{}');
    process.env.GOOGLE_MAIL_CLIENT_ID = 'id';
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
    process.env.PUBLIC_BASE_URL = 'https://app.example.com';
    prisma = { channel: { findFirst: jest.fn().mockResolvedValue(null) } };
    channels = {
      create: jest.fn().mockResolvedValue({ id: 'ch-new' }),
      update: jest.fn().mockResolvedValue({ id: 'ch-old' }),
    };
    health = { clearOAuthReauthRequired: jest.fn().mockResolvedValue(undefined) };
    svc = new EmailOAuthService(prisma, channels, health);
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

    it('says out loud that consent does not bring replies', () => {
      // The owner connects a mailbox expecting a mailbox. Send-only is a fact
      // about the scope, not a bug, and it belongs on the button — not in a
      // support thread three days later.
      expect(svc.providers()[0]).toMatchObject({
        provider: 'GOOGLE',
        receive: 'NONE',
        receiveReason: 'GMAIL_READ_NEEDS_CASA',
      });
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

    it('hands the minted state back, so the controller can bind it to this browser', () => {
      // The signature alone proves the state was made here, not WHO it was made
      // for: a forwarded authorize URL would otherwise attach the victim's
      // mailbox to the sender's workspace. The controller binds this exact
      // value to a cookie; it cannot do that if it never sees it.
      const r = svc.start(WS, 'GOOGLE');
      expect(r.state).toBe('signed-state');
      expect(r.authorizeUrl).toContain('state=signed-state');
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
        // Consent at the provider IS the proof of the address: `/me` is the
        // provider saying which mailbox the owner signed into. Without it the
        // address is PARKED, and the mailbox never claims its own identity.
        addressProof: 'oauth',
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

    it('clears the SMTP block when nothing on the receive side is using it', async () => {
      // secrets MERGE, so without this a dead password stays sealed beside a
      // live token — a credential nobody is watching any more. A half-filled
      // form (a user with no password) can send nothing and receive nothing.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      sealedAs({ smtpHost: 'smtp.figurunica.com', smtpPort: '587', smtpUser: ADDRESS });

      await svc.handleCallback('code', 's');

      expect(clearedOnReconnect()).toEqual(
        expect.arrayContaining(['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass']),
      );
    });

    it('keeps the mailbox password that inbound is logging in with', async () => {
      // THE regression this pins: the IMAP services authenticate with
      // smtpUser/smtpPass (imap-target.ts), so clearing them on a reconnect
      // turned a two-way mailbox one-way — silently, with the owner's replies
      // simply never arriving again. Consent replaces the SEND half only.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      sealedAs({ smtpHost: 'smtp.figurunica.com', smtpUser: ADDRESS, smtpPass: 'app-password' });

      await svc.handleCallback('code', 's');

      const cleared = clearedOnReconnect();
      expect(cleared).not.toContain('smtpPass');
      expect(cleared).not.toContain('smtpUser');
      // …and the host with them: it is what the IMAP host is discovered from
      // when nobody typed one.
      expect(cleared).not.toContain('smtpHost');
    });

    it('never touches a receive-only credential', async () => {
      // Dedicated inbound keys belong to the mailbox form, never to consent —
      // and their presence is what makes the shared SMTP block genuinely dead.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      sealedAs({
        smtpHost: 'smtp.figurunica.com',
        smtpUser: ADDRESS,
        smtpPass: 'old-send-password',
        imapHost: 'imap.figurunica.com',
        imapUser: ADDRESS,
        imapPass: 'app-password',
      });

      await svc.handleCallback('code', 's');

      const cleared = clearedOnReconnect();
      for (const k of ['imapUser', 'imapPass', 'imapHost', 'imapPort', 'imapSecure']) {
        expect(cleared).not.toContain(k);
      }
      expect(cleared).toEqual(expect.arrayContaining(['smtpUser', 'smtpPass']));
    });

    it('clears the SMTP block on a plain consent-to-consent reconnect', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      sealedAs({ oauthProvider: 'GOOGLE', oauthAccessToken: 'old', fromEmail: ADDRESS });

      await svc.handleCallback('code', 's');

      expect(clearedOnReconnect()).toEqual(expect.arrayContaining(['smtpUser', 'smtpPass']));
    });

    it('falls back to the full clear when the old box cannot be opened', async () => {
      // An unreadable box is replaced wholesale by ChannelsService anyway; the
      // point is that a throw in here must not fail the reconnect.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      prisma.channel.findFirst.mockResolvedValue({ id: 'ch-old', configSealed: 'corrupt' });
      openSecretMock.mockImplementation(() => {
        throw new Error('bad box');
      });

      await expect(svc.handleCallback('code', 's')).resolves.toMatchObject({ channelId: 'ch-old' });
      expect(clearedOnReconnect()).toEqual(expect.arrayContaining(['smtpUser', 'smtpPass']));
    });

    it('drops the old refusal, so a reconnected mailbox is allowed to send again', async () => {
      // `oauthError` is what the refresh sweep writes when consent is revoked,
      // and WorkspaceMailboxService refuses any mailbox carrying one. Secrets
      // MERGE, so a reconnect that left it standing would produce a channel the
      // owner just fixed and the sender still will not use.
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      prisma.channel.findFirst.mockResolvedValue({ id: 'ch-old' });

      await svc.handleCallback('code', 's');

      expect(channels.update.mock.calls[0][2].clearSecretKeys).toContain('oauthError');
      // …and the marker outside the box comes down with it, rather than waiting
      // for whichever sweep happens to succeed next.
      expect(health.clearOAuthReauthRequired).toHaveBeenCalledWith({ id: 'ch-old', workspaceId: WS });
    });

    it('never fails a reconnect because the marker could not be cleared', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      prisma.channel.findFirst.mockResolvedValue({ id: 'ch-old' });
      health.clearOAuthReauthRequired.mockRejectedValue(new Error('db down'));

      await expect(svc.handleCallback('code', 's')).resolves.toMatchObject({ channelId: 'ch-old' });
    });

    it('looks the channel up inside the state workspace only', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      await svc.handleCallback('code', 's');
      const where = prisma.channel.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, type: 'EMAIL' });
      // Both spellings of "we already have this mailbox": an address that was
      // never proven is PARKED with a null externalId, so matching only on
      // externalId misses the row a first SMTP connect left behind and sends
      // the reconnect down the create path.
      expect(where.OR).toEqual([
        { externalId: ADDRESS },
        { externalId: null, configPublic: { path: ['pendingAddress'], equals: ADDRESS } },
      ]);
    });

    it('promotes a PARKED address into a real claim on reconnect', async () => {
      verifyStateMock.mockReturnValue({ workspaceId: WS, network: 'email-google' });
      exchangeMock.mockResolvedValue(GOOD_TOKENS);
      addressMock.mockResolvedValue(ADDRESS);
      prisma.channel.findFirst.mockResolvedValue({
        id: 'ch-parked',
        externalId: null,
        configPublic: { pendingAddress: ADDRESS },
      });

      const r = await svc.handleCallback('code', 's');

      expect(r.channelId).toBe('ch-parked');
      expect(channels.create).not.toHaveBeenCalled();
      const [, , patch] = channels.update.mock.calls[0];
      expect(patch).toMatchObject({ externalId: ADDRESS, addressProof: 'oauth' });
    });
  });
});
