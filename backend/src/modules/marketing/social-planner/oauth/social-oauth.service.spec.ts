import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialOAuthService } from './social-oauth.service';
import { sealSecret } from '../../../../common/crypto/secret-box.helper';
import { metaGraphFetch } from '../../../../common/util/meta-graph.util';

// provisionMetaMessagingChannel subscribes the Page to our messaging webhook via
// the Graph API — mock it so no real network call fires; default to success.
jest.mock('../../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: jest.fn().mockResolvedValue({ ok: true }),
}));
const mockGraph = metaGraphFetch as jest.Mock;

describe('SocialOAuthService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let channels: any;
  let ads: any;
  let entitlements: any;
  let svc: SocialOAuthService;

  const sealedPayload = (assets: any[], token = 'usertok', refreshToken: string | null = null) =>
    sealSecret(JSON.stringify({ token, refreshToken, expiresAt: null, assets }));

  beforeAll(() => {
    // secret-box requires a key that base64-decodes to exactly 32 bytes.
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  beforeEach(() => {
    prisma = {
      pendingSocialConnection: {
        create: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
      socialAccount: { upsert: jest.fn().mockResolvedValue({ id: 'a' }) },
    };
    channels = { create: jest.fn().mockResolvedValue({ id: 'ch' }) };
    ads = { connect: jest.fn().mockResolvedValue({ id: 'ad' }) };
    // Messaging-channel provisioning is gated on conversationAi — entitled by default.
    entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { conversationAi: true } }) };
    mockGraph.mockReset().mockResolvedValue({ ok: true });
    svc = new SocialOAuthService(prisma as any, channels as any, ads as any, entitlements as any);
  });

  describe('start', () => {
    afterEach(() => {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
      delete process.env.X_CLIENT_ID;
      delete process.env.X_CLIENT_SECRET;
      delete process.env.PUBLIC_BASE_URL;
    });

    it('throws when the network is not OAuth-configured', () => {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
      expect(() => svc.start(WS, 'FACEBOOK')).toThrow(BadRequestException);
    });

    it('returns an authorize URL when configured', () => {
      process.env.META_APP_ID = 'a';
      process.env.META_APP_SECRET = 'b';
      const { authorizeUrl } = svc.start(WS, 'FACEBOOK');
      expect(authorizeUrl).toContain('client_id=a');
      expect(authorizeUrl).toContain('state=');
    });

    it('rejects an unsupported network', () => {
      expect(() => svc.start(WS, 'MYSPACE')).toThrow(BadRequestException);
    });

    it('X/Twitter: emits a PKCE challenge and a state carrying the SEALED verifier', () => {
      process.env.X_CLIENT_ID = 'xid';
      process.env.X_CLIENT_SECRET = 'xsecret';
      process.env.PUBLIC_BASE_URL = 'https://api.x';
      const { authorizeUrl } = svc.start(WS, 'TWITTER');
      const u = new URL(authorizeUrl);
      const challenge = u.searchParams.get('code_challenge');
      const state = u.searchParams.get('state');
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(challenge).toBeTruthy();
      // The state body decodes to a payload with a sealed `cv`, NOT a plaintext
      // verifier or the challenge (PKCE secrecy: an interceptor can't recover it).
      const body = JSON.parse(Buffer.from(state!.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
      expect(typeof body.cv).toBe('string');
      expect(body.cv).toMatch(/^v1:/); // sealSecret envelope, not plaintext
      expect(body.cv).not.toContain(challenge);
    });
  });

  describe('handleCallback', () => {
    it('rejects an invalid state', async () => {
      await expect(svc.handleCallback('FACEBOOK', 'code', 'bad-state')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('listPending', () => {
    it('strips tokens from the returned assets', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1',
        workspaceId: WS,
        network: 'FACEBOOK',
        expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: 'P1', displayName: 'Acme', accountType: 'PAGE', token: 'pt1' },
        ]),
      });
      const out = await svc.listPending(WS, 'p1');
      expect(out.network).toBe('FACEBOOK');
      expect(out.assets[0]).toEqual({ externalId: 'P1', displayName: 'Acme', accountType: 'PAGE' });
      expect((out.assets[0] as any).token).toBeUndefined();
    });

    it('404s when the pending row is missing/other workspace', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue(null);
      await expect(svc.listPending(WS, 'nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirm', () => {
    beforeEach(() => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1',
        workspaceId: WS,
        network: 'FACEBOOK',
        expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload(
          [
            { externalId: 'P1', displayName: 'Acme', accountType: 'PAGE', token: 'pt1' },
            { externalId: 'IG1', displayName: '@acme', accountType: 'IG_BUSINESS', token: 'pt1' },
          ],
          'usertok',
          'reftok',
        ),
      });
    });

    it('creates an OAUTH SocialAccount only for the selected asset and deletes the pending row', async () => {
      const out = await svc.confirm(WS, 'p1', ['P1']);
      expect(out).toMatchObject({ connected: 1, socialAccounts: 1, channels: 0, adAccounts: 0 });
      expect(prisma.socialAccount.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.socialAccount.upsert.mock.calls[0][0];
      expect(arg.where.workspaceId_network_externalId).toEqual({
        workspaceId: WS,
        network: 'FACEBOOK',
        externalId: 'P1',
      });
      expect(arg.create.connectedVia).toBe('OAUTH');
      expect(arg.create.accountType).toBe('PAGE');
      // token is sealed, not raw
      expect(arg.create.accessToken).not.toBe('pt1');
      expect(arg.create.refreshToken).not.toBeNull();
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });

    it('connects multiple selected assets', async () => {
      const out = await svc.confirm(WS, 'p1', ['P1', 'IG1']);
      expect(out).toMatchObject({ connected: 2, socialAccounts: 2 });
      expect(prisma.socialAccount.upsert).toHaveBeenCalledTimes(2);
    });

    it('stores a PAGE under FACEBOOK and an IG account under INSTAGRAM regardless of the OAuth flow network', async () => {
      // Meta's single Login-for-Business returns BOTH Pages and IG accounts; the flow may
      // have been started as INSTAGRAM. The stored SocialAccount.network must reflect the
      // ASSET (Page→FACEBOOK, IG→INSTAGRAM) so the publisher routes to the right Graph
      // endpoint (/feed vs /media). A Page mis-stored as INSTAGRAM silently fails to publish.
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'INSTAGRAM', expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: 'P1', displayName: 'Acme', accountType: 'PAGE', token: 'pt1' },
          { externalId: 'IG1', displayName: '@acme', accountType: 'IG_BUSINESS', token: 'pt1' },
        ]),
      });
      await svc.confirm(WS, 'p1', ['P1', 'IG1']);
      const keys = prisma.socialAccount.upsert.mock.calls.map(
        (c: any) => c[0].where.workspaceId_network_externalId,
      );
      expect(keys).toContainEqual({ workspaceId: WS, network: 'FACEBOOK', externalId: 'P1' });
      expect(keys).toContainEqual({ workspaceId: WS, network: 'INSTAGRAM', externalId: 'IG1' });
      // and the create payload carries the same corrected network
      const pageCall = prisma.socialAccount.upsert.mock.calls.find((c: any) => c[0].create.externalId === 'P1');
      expect(pageCall[0].create.network).toBe('FACEBOOK');
    });

    it('throws when nothing is selected', async () => {
      await expect(svc.confirm(WS, 'p1', [])).rejects.toThrow(BadRequestException);
    });

    it('provisions a WHATSAPP number as a WHATSAPP Channel (no SocialAccount)', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'FACEBOOK', expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: 'PN1', displayName: 'Acme WA', accountType: 'WHATSAPP_NUMBER', token: 'usertok', meta: { phoneNumberId: 'PN1' } },
        ]),
      });
      const out = await svc.confirm(WS, 'p1', ['PN1']);
      expect(out).toMatchObject({ channels: 1, socialAccounts: 0 });
      expect(channels.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ type: 'WHATSAPP', externalId: 'PN1', secrets: { accessToken: 'usertok', phoneNumberId: 'PN1' } }),
      );
      expect(prisma.socialAccount.upsert).not.toHaveBeenCalled();
    });

    it('provisions an AD_ACCOUNT via AdAccountService.connect', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'FACEBOOK', expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: '123', displayName: 'Biz Ads', accountType: 'AD_ACCOUNT', token: 'usertok', meta: { accountId: '123', currency: 'USD' } },
        ]),
      });
      const out = await svc.confirm(WS, 'p1', ['123']);
      expect(out).toMatchObject({ adAccounts: 1 });
      expect(ads.connect).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ provider: 'META', externalAdId: '123', accessToken: 'usertok', currency: 'USD' }),
      );
    });

    it('also creates a MESSENGER Channel for a Page when opted in via provisionMessaging', async () => {
      const out = await svc.confirm(WS, 'p1', ['P1'], ['P1']);
      expect(out).toMatchObject({ socialAccounts: 1, channels: 1 });
      expect(channels.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ type: 'MESSENGER', externalId: 'P1', secrets: { pageAccessToken: 'pt1' } }),
      );
    });

    it('subscribes the Page to the messaging webhook when provisioning MESSENGER', async () => {
      await svc.confirm(WS, 'p1', ['P1'], ['P1']);
      expect(mockGraph).toHaveBeenCalledWith(
        '/P1/subscribed_apps',
        expect.objectContaining({ method: 'POST', accessToken: 'pt1' }),
      );
    });

    it('IG_BUSINESS → an INSTAGRAM channel keyed by the IG id, webhook on the LINKED Page', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'FACEBOOK', expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: 'IG9', displayName: '@acme', accountType: 'IG_BUSINESS', token: 'pt9', meta: { pageId: 'PG9' } },
        ]),
      });
      const out = await svc.confirm(WS, 'p1', ['IG9'], ['IG9']);
      expect(out).toMatchObject({ channels: 1 });
      expect(channels.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ type: 'INSTAGRAM', externalId: 'IG9', secrets: { pageAccessToken: 'pt9' } }),
      );
      // The subscription lives on the linked PAGE (PG9), not the IG account id.
      expect(mockGraph).toHaveBeenCalledWith('/PG9/subscribed_apps', expect.objectContaining({ method: 'POST' }));
    });

    it('a webhook-subscribe failure is best-effort — the channel is still created + counted', async () => {
      mockGraph.mockResolvedValue({ ok: false, status: 403, error: { message: 'needs review' } });
      const out = await svc.confirm(WS, 'p1', ['P1'], ['P1']);
      expect(out).toMatchObject({ socialAccounts: 1, channels: 1 });
      expect(out.skipped).toEqual([]);
    });

    it('a webhook-subscribe TRANSPORT throw is still best-effort (channel kept + counted, not skipped)', async () => {
      mockGraph.mockRejectedValue(new Error('socket hang up'));
      const out = await svc.confirm(WS, 'p1', ['P1'], ['P1']);
      expect(out).toMatchObject({ socialAccounts: 1, channels: 1 });
      expect(out.skipped).toEqual([]);
      expect(channels.create).toHaveBeenCalledTimes(1);
    });

    it('gates messaging on conversationAi: still connects the SocialAccount but skips the channel when unentitled', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { conversationAi: false } });
      const out = await svc.confirm(WS, 'p1', ['P1'], ['P1']);
      expect(out).toMatchObject({ socialAccounts: 1, channels: 0 });
      expect(out.skipped).toEqual([
        { externalId: 'P1', reason: 'messaging: conversationAi feature not in plan' },
      ]);
      expect(channels.create).not.toHaveBeenCalled();
    });

    it('gates a WhatsApp number on conversationAi when unentitled', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { conversationAi: false } });
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'FACEBOOK', expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: 'PN1', displayName: 'WA', accountType: 'WHATSAPP_NUMBER', token: 'usertok', meta: { phoneNumberId: 'PN1' } },
        ]),
      });
      const out = await svc.confirm(WS, 'p1', ['PN1']);
      expect(out).toMatchObject({ channels: 0, socialAccounts: 0 });
      expect(out.skipped).toEqual([
        { externalId: 'PN1', reason: 'messaging: conversationAi feature not in plan' },
      ]);
      expect(channels.create).not.toHaveBeenCalled();
    });

    it('records a (type,externalId) collision in skipped instead of aborting', async () => {
      const { ConflictException } = require('@nestjs/common');
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'FACEBOOK', expiresAt: new Date(Date.now() + 60000),
        payload: sealedPayload([
          { externalId: 'PN1', displayName: 'WA', accountType: 'WHATSAPP_NUMBER', token: 'usertok', meta: { phoneNumberId: 'PN1' } },
        ]),
      });
      channels.create.mockRejectedValueOnce(new ConflictException('taken'));
      const out = await svc.confirm(WS, 'p1', ['PN1']);
      expect(out.channels).toBe(0);
      expect(out.skipped).toEqual([{ externalId: 'PN1', reason: 'taken' }]);
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalled();
    });

    it('keeps the publishing SocialAccount but skips a failed messaging channel (messaging: prefix)', async () => {
      const { ConflictException } = require('@nestjs/common');
      channels.create.mockRejectedValueOnce(new ConflictException('taken'));
      const out = await svc.confirm(WS, 'p1', ['P1'], ['P1']);
      expect(out).toMatchObject({ socialAccounts: 1, channels: 0, connected: 1 });
      expect(out.skipped).toEqual([{ externalId: 'P1', reason: 'messaging: taken' }]);
      expect(prisma.socialAccount.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('loadPending (expiry)', () => {
    it('rejects an expired pending row', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: 'p1', workspaceId: WS, network: 'FACEBOOK', expiresAt: new Date(Date.now() - 1000), payload: 'x',
      });
      await expect(svc.listPending(WS, 'p1')).rejects.toThrow(BadRequestException);
    });
  });
});
