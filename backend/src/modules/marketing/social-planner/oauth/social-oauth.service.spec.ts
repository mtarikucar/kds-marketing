import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialOAuthService } from './social-oauth.service';
import { sealSecret } from '../../../../common/crypto/secret-box.helper';

describe('SocialOAuthService', () => {
  const WS = 'ws-1';
  let prisma: any;
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
    svc = new SocialOAuthService(prisma as any);
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
      expect(out).toEqual({ connected: 1 });
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
      expect(out).toEqual({ connected: 2 });
      expect(prisma.socialAccount.upsert).toHaveBeenCalledTimes(2);
    });

    it('throws when nothing is selected', async () => {
      await expect(svc.confirm(WS, 'p1', [])).rejects.toThrow(BadRequestException);
    });
  });
});
