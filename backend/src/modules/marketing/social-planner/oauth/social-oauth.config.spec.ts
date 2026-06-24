import { NETWORK_OAUTH, isOAuthConfigured, redirectUri, isOAuthNetwork } from './social-oauth.config';

describe('social oauth config', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('builds the redirect uri from PUBLIC_BASE_URL + /api', () => {
    process.env.PUBLIC_BASE_URL = 'https://marketing.example.com';
    expect(redirectUri('FACEBOOK')).toBe(
      'https://marketing.example.com/api/marketing/social/oauth/facebook/callback',
    );
    expect(redirectUri('TIKTOK')).toBe(
      'https://marketing.example.com/api/marketing/social/oauth/tiktok/callback',
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
    expect(isOAuthNetwork('INSTAGRAM_LOGIN')).toBe(true);
    expect(isOAuthNetwork('MYSPACE')).toBe(false);
  });

  it('instagram-login uses instagram.com authorize + its own app creds + publish scope', () => {
    expect(NETWORK_OAUTH.INSTAGRAM_LOGIN.authorizeUrl).toBe('https://www.instagram.com/oauth/authorize');
    expect(NETWORK_OAUTH.INSTAGRAM_LOGIN.clientIdEnv).toBe('INSTAGRAM_APP_ID');
    expect(NETWORK_OAUTH.INSTAGRAM_LOGIN.clientSecretEnv).toBe('INSTAGRAM_APP_SECRET');
    expect(NETWORK_OAUTH.INSTAGRAM_LOGIN.scopes).toContain('instagram_business_content_publish');
    expect(NETWORK_OAUTH.INSTAGRAM_LOGIN.scopeSep).toBe(',');
  });

  it('instagram-login redirect uri lowercases the network', () => {
    process.env.PUBLIC_BASE_URL = 'https://marketing.example.com';
    expect(redirectUri('INSTAGRAM_LOGIN')).toBe(
      'https://marketing.example.com/api/marketing/social/oauth/instagram_login/callback',
    );
  });

  it('isOAuthConfigured(INSTAGRAM_LOGIN) reflects INSTAGRAM_APP_* env presence', () => {
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    expect(isOAuthConfigured('INSTAGRAM_LOGIN')).toBe(false);
    process.env.INSTAGRAM_APP_ID = 'a';
    process.env.INSTAGRAM_APP_SECRET = 'b';
    expect(isOAuthConfigured('INSTAGRAM_LOGIN')).toBe(true);
  });
});
