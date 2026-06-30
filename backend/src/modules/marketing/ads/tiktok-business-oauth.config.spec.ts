import {
  isTiktokBusinessConfigured,
  tiktokBusinessRedirectUri,
  buildTiktokBusinessAuthorizeUrl,
} from './tiktok-business-oauth.config';

describe('tiktok-business-oauth.config', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });
  afterAll(() => {
    process.env = origEnv;
  });

  describe('isTiktokBusinessConfigured', () => {
    it('returns false when both vars are missing', () => {
      delete process.env.TIKTOK_BUSINESS_APP_ID;
      delete process.env.TIKTOK_BUSINESS_APP_SECRET;
      expect(isTiktokBusinessConfigured()).toBe(false);
    });

    it('returns false when only APP_ID is set', () => {
      process.env.TIKTOK_BUSINESS_APP_ID = 'app123';
      delete process.env.TIKTOK_BUSINESS_APP_SECRET;
      expect(isTiktokBusinessConfigured()).toBe(false);
    });

    it('returns true when both vars are set', () => {
      process.env.TIKTOK_BUSINESS_APP_ID = 'app123';
      process.env.TIKTOK_BUSINESS_APP_SECRET = 'secret456';
      expect(isTiktokBusinessConfigured()).toBe(true);
    });
  });

  describe('tiktokBusinessRedirectUri', () => {
    it('appends the callback path to PUBLIC_BASE_URL stripping trailing slashes', () => {
      process.env.PUBLIC_BASE_URL = 'https://api.example.com///';
      expect(tiktokBusinessRedirectUri()).toBe(
        'https://api.example.com/api/marketing/ads/oauth/tiktok/callback',
      );
    });

    it('works when PUBLIC_BASE_URL has no trailing slash', () => {
      process.env.PUBLIC_BASE_URL = 'https://api.example.com';
      expect(tiktokBusinessRedirectUri()).toBe(
        'https://api.example.com/api/marketing/ads/oauth/tiktok/callback',
      );
    });
  });

  describe('buildTiktokBusinessAuthorizeUrl', () => {
    it('builds a URL with app_id, state, and redirect_uri encoded', () => {
      process.env.TIKTOK_BUSINESS_APP_ID = 'myapp';
      process.env.PUBLIC_BASE_URL = 'https://api.example.com';
      const url = buildTiktokBusinessAuthorizeUrl('test-state-123');
      expect(url).toContain('https://business-api.tiktok.com/portal/auth');
      expect(url).toContain('app_id=myapp');
      expect(url).toContain('state=test-state-123');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain(encodeURIComponent('https://api.example.com/api/marketing/ads/oauth/tiktok/callback'));
    });
  });
});
