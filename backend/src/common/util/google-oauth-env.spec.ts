import { googleOAuthClientId, googleOAuthClientSecret, isGoogleOAuthConfigured } from './google-oauth-env';

describe('google-oauth-env (unified env names)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) {
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
  });
  beforeEach(() => {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) delete process.env[k];
  });

  it('reads the OAUTH-prefixed name (Calendar convention)', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = ' cid ';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csecret';
    expect(googleOAuthClientId()).toBe('cid'); // trimmed
    expect(googleOAuthClientSecret()).toBe('csecret');
    expect(isGoogleOAuthConfigured()).toBe(true);
  });

  it('falls back to the bare name (review-sync / GMB convention), so one config enables both', () => {
    process.env.GOOGLE_CLIENT_ID = 'cid2';
    process.env.GOOGLE_CLIENT_SECRET = 'csec2';
    expect(googleOAuthClientId()).toBe('cid2');
    expect(isGoogleOAuthConfigured()).toBe(true);
  });

  it('is unconfigured when neither pair is set', () => {
    expect(isGoogleOAuthConfigured()).toBe(false);
    expect(googleOAuthClientId()).toBeUndefined();
  });
});
