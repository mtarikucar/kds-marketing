import { NETWORK_OAUTH, isOAuthConfigured, redirectUri, isOAuthNetwork } from './social-oauth.config';

describe('social oauth config', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('builds the redirect uri from API_URL', () => {
    process.env.API_URL = 'https://api.example.com/api';
    expect(redirectUri('FACEBOOK')).toBe(
      'https://api.example.com/api/marketing/social/oauth/facebook/callback',
    );
    expect(redirectUri('TIKTOK')).toBe(
      'https://api.example.com/api/marketing/social/oauth/tiktok/callback',
    );
  });

  it('facebook requires the page publish scope', () => {
    expect(NETWORK_OAUTH.FACEBOOK.scopes).toContain('pages_manage_posts');
  });

  it('instagram requires content publish scope', () => {
    expect(NETWORK_OAUTH.INSTAGRAM.scopes).toContain('instagram_content_publish');
  });

  it('linkedin includes org + member share scopes', () => {
    expect(NETWORK_OAUTH.LINKEDIN.scopes).toEqual(
      expect.arrayContaining(['w_member_social', 'w_organization_social']),
    );
  });

  it('isOAuthConfigured reflects env presence', () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    expect(isOAuthConfigured('FACEBOOK')).toBe(false);
    process.env.META_APP_ID = 'a';
    process.env.META_APP_SECRET = 'b';
    expect(isOAuthConfigured('FACEBOOK')).toBe(true);
  });

  it('isOAuthNetwork guards unknown networks', () => {
    expect(isOAuthNetwork('FACEBOOK')).toBe(true);
    expect(isOAuthNetwork('MYSPACE')).toBe(false);
  });
});
