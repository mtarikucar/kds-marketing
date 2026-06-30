import {
  isLinkedinAdsConfigured,
  linkedinAdsRedirectUri,
  buildLinkedinAdsAuthorizeUrl,
  LINKEDIN_ADS_TOKEN_URL,
} from './linkedin-ads-oauth.config';

describe('linkedin-ads-oauth.config', () => {
  const orig = process.env;
  beforeEach(() => {
    process.env = { ...orig };
  });
  afterAll(() => {
    process.env = orig;
  });

  describe('isLinkedinAdsConfigured (re-export)', () => {
    it('true only when both ads vars are set', () => {
      process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
      process.env.LINKEDIN_ADS_CLIENT_SECRET = 'sec';
      expect(isLinkedinAdsConfigured()).toBe(true);
      delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
      expect(isLinkedinAdsConfigured()).toBe(false);
    });
  });

  describe('linkedinAdsRedirectUri', () => {
    it('appends the callback path, stripping trailing slashes', () => {
      process.env.PUBLIC_BASE_URL = 'https://api.example.com///';
      expect(linkedinAdsRedirectUri()).toBe(
        'https://api.example.com/api/marketing/ads/oauth/linkedin/callback',
      );
    });
  });

  describe('buildLinkedinAdsAuthorizeUrl', () => {
    it('builds the authorize URL with client id, state, redirect, and space-delimited ads scopes', () => {
      process.env.LINKEDIN_ADS_CLIENT_ID = 'LIADS';
      process.env.PUBLIC_BASE_URL = 'https://api.example.com';
      const url = buildLinkedinAdsAuthorizeUrl('st-123');
      expect(url).toContain('https://www.linkedin.com/oauth/v2/authorization');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=LIADS');
      expect(url).toContain('state=st-123');
      expect(url).toContain(
        'redirect_uri=' +
          encodeURIComponent('https://api.example.com/api/marketing/ads/oauth/linkedin/callback'),
      );
      // space-delimited scopes → encoded as %20
      expect(url).toContain('scope=r_ads_reporting%20r_ads');
    });
  });

  it('exposes the LinkedIn token endpoint', () => {
    expect(LINKEDIN_ADS_TOKEN_URL).toBe('https://www.linkedin.com/oauth/v2/accessToken');
  });
});
