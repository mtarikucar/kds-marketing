import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialOAuthService } from './social-oauth.service';
import { sealSecret } from '../../../../common/crypto/secret-box.helper';

describe('SocialOAuthService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let channels: any;
  let ads: any;
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
    svc = new SocialOAuthService(prisma as any, channels as any, ads as any);
  });

  describe('start', () => {
    afterEach(() => {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
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
