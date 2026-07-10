// isGoogleAdsConfigured lives in ads.types.ts (added there by the integrator).
// Mock that module with the expected 4-var implementation so this config spec
// runs green in isolation and documents the gate the integrator must ship.
jest.mock('./ads.types', () => ({
  isGoogleAdsConfigured: () =>
    !!(
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
      process.env.GOOGLE_ADS_CLIENT_ID &&
      process.env.GOOGLE_ADS_CLIENT_SECRET &&
      process.env.GOOGLE_ADS_REFRESH_TOKEN
    ),
}));

import {
  isGoogleAdsConfigured,
  googleAdsRedirectUri,
  buildGoogleAdsAuthorizeUrl,
  GOOGLE_ADS_TOKEN_URL,
  GOOGLE_ADS_AUTHORIZE_URL,
} from './google-ads-oauth.config';

describe('google-ads-oauth.config', () => {
  const orig = process.env;
  beforeEach(() => {
    process.env = { ...orig };
  });
  afterAll(() => {
    process.env = orig;
  });

  describe('isGoogleAdsConfigured (re-export)', () => {
    it('true only when all four Google Ads vars are set', () => {
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev';
      process.env.GOOGLE_ADS_CLIENT_ID = 'cid';
      process.env.GOOGLE_ADS_CLIENT_SECRET = 'sec';
      process.env.GOOGLE_ADS_REFRESH_TOKEN = 'rt';
      expect(isGoogleAdsConfigured()).toBe(true);
      delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
      expect(isGoogleAdsConfigured()).toBe(false);
    });
  });

  describe('googleAdsRedirectUri', () => {
    it('appends the google callback path, stripping trailing slashes', () => {
      process.env.PUBLIC_BASE_URL = 'https://api.example.com///';
      expect(googleAdsRedirectUri()).toBe(
        'https://api.example.com/api/marketing/ads/oauth/google/callback',
      );
    });
  });

  describe('buildGoogleAdsAuthorizeUrl', () => {
    it('builds the authorize URL with offline access, forced consent, the adwords scope, client id, state and redirect', () => {
      process.env.GOOGLE_ADS_CLIENT_ID = 'GADS';
      process.env.PUBLIC_BASE_URL = 'https://api.example.com';
      const url = buildGoogleAdsAuthorizeUrl('st-123');
      expect(url).toContain(GOOGLE_ADS_AUTHORIZE_URL);
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=GADS');
      expect(url).toContain('state=st-123');
      expect(url).toContain('access_type=offline');
      expect(url).toContain('prompt=consent');
      // scope is the adwords scope (URLSearchParams percent-encodes the URL value)
      expect(url).toContain('adwords');
      expect(url).toContain(
        'redirect_uri=' +
          encodeURIComponent('https://api.example.com/api/marketing/ads/oauth/google/callback'),
      );
    });
  });

  it('exposes the Google token + authorize endpoints', () => {
    expect(GOOGLE_ADS_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect(GOOGLE_ADS_AUTHORIZE_URL).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });
});
