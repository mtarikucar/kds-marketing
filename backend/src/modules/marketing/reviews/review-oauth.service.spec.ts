jest.mock('../../../common/util/safe-fetch', () => ({ safeFetch: jest.fn() }));

import { ReviewOAuthService } from './review-oauth.service';
import { safeFetch } from '../../../common/util/safe-fetch';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

const safeFetchMock = safeFetch as unknown as jest.Mock;

describe('ReviewOAuthService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: ReviewOAuthService;
  const saved = { ...process.env };

  beforeAll(() => { process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 5).toString('base64'); });

  beforeEach(() => {
    safeFetchMock.mockReset();
    for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'META_APP_ID', 'META_APP_SECRET']) delete process.env[k];
    process.env.MARKETING_PUBLIC_URL = 'https://app.example';
    prisma = {
      reviewSource: {
        findFirst: jest.fn().mockResolvedValue({ type: 'GOOGLE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    svc = new ReviewOAuthService(prisma as any);
  });

  afterAll(() => { process.env = saved; });

  describe('connectUrl', () => {
    it('is inert (400) until the provider OAuth client is configured', async () => {
      await expect(svc.connectUrl(WS, 's1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('builds a Google consent URL with a sealed state', async () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid';
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsec';
      const { url } = await svc.connectUrl(WS, 's1');
      expect(url).toContain('accounts.google.com/o/oauth2');
      expect(url).toContain('business.manage');
      expect(url).toContain('access_type=offline');
      expect(url).toMatch(/state=v1/); // sealed state token
    });

    it('builds a Facebook dialog URL for a FACEBOOK source', async () => {
      prisma.reviewSource.findFirst.mockResolvedValue({ type: 'FACEBOOK' });
      process.env.META_APP_ID = 'app'; process.env.META_APP_SECRET = 'sec';
      const { url } = await svc.connectUrl(WS, 's2');
      expect(url).toContain('facebook.com');
      expect(url).toContain('dialog/oauth');
    });
  });

  describe('handleCallback', () => {
    const validState = () => {
      const { sealSecret } = require('../../../common/crypto/secret-box.helper');
      return sealSecret(JSON.stringify({ workspaceId: WS, sourceId: 's1', type: 'GOOGLE', expiresAt: Date.now() + 60_000 }));
    };

    it('rejects a forged/expired state', async () => {
      await expect(svc.handleCallback('not-sealed', 'code')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('exchanges the code and seals the token onto the source', async () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid'; process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsec';
      safeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ refresh_token: 'rt-123' }) });
      const out = await svc.handleCallback(validState(), 'auth-code');
      expect(out).toEqual({ workspaceId: WS, sourceId: 's1' });
      const data = prisma.reviewSource.updateMany.mock.calls[0][0];
      expect(data.where).toMatchObject({ id: 's1', workspaceId: WS });
      expect(data.data.accessToken).toMatch(/^v1:/); // sealed
      expect(JSON.stringify(data.data)).not.toContain('rt-123'); // raw token never stored
      expect(data.data.syncStatus).toBe('ACTIVE');
    });
  });
});
