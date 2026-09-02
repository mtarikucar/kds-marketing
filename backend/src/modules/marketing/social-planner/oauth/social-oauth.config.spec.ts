import {
  NETWORK_OAUTH,
  OAUTH_NETWORKS,
  clientId,
  clientSecret,
  isOAuthConfigured,
  redirectUri,
  isOAuthNetwork,
  scopesFor,
  insightsScopesFor,
} from './social-oauth.config';

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

describe('LinkedIn OAuth scopes', () => {
  it('uses the real r_organization_social read scope, not the non-existent r_organization_admin', () => {
    expect(NETWORK_OAUTH.LINKEDIN.scopes).toContain('r_organization_social');
    expect(NETWORK_OAUTH.LINKEDIN.scopes).not.toContain('r_organization_admin');
  });
  it('still requests member posting + org posting + openid identity', () => {
    expect(NETWORK_OAUTH.LINKEDIN.scopes).toEqual(
      expect.arrayContaining(['openid', 'profile', 'w_member_social', 'w_organization_social']),
    );
  });
});

describe('scopesFor — LinkedIn org-scope gating', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  // LinkedIn's Community Management API (org posting/reading) must live on a
  // SEPARATE, CMA-approved app. Requesting org scopes from the self-serve app
  // makes LinkedIn reject the whole authorize request, so they are gated off
  // until LINKEDIN_ORG_SCOPES is set.
  it('default: LinkedIn effective scopes exclude the org scopes', () => {
    delete process.env.LINKEDIN_ORG_SCOPES;
    expect(scopesFor('LINKEDIN')).toEqual(['openid', 'profile', 'w_member_social']);
  });

  it('LINKEDIN_ORG_SCOPES=1 restores the full static list', () => {
    process.env.LINKEDIN_ORG_SCOPES = '1';
    expect(scopesFor('LINKEDIN')).toEqual(NETWORK_OAUTH.LINKEDIN.scopes);
  });

  it('other networks pass through the static list unchanged', () => {
    delete process.env.LINKEDIN_ORG_SCOPES;
    expect(scopesFor('TIKTOK')).toEqual(NETWORK_OAUTH.TIKTOK.scopes);
    expect(scopesFor('FACEBOOK')).toEqual(NETWORK_OAUTH.FACEBOOK.scopes);
  });
});

/**
 * The READ half of each grant.
 *
 * The organic-insights pipeline needs permissions the connect flows have never
 * asked for, and asking for an unapproved one is not free — LinkedIn rejects the
 * whole authorize request, TikTok refuses an unregistered scope, and Meta shows
 * the user a consent screen naming something it will not grant. So each rides an
 * env flag that ops flips when that provider's app review clears.
 *
 * These assertions are the promise that shipping the pipeline changed nothing
 * about what a customer is asked to consent to.
 */
describe('scopesFor — insights scopes are opt-in per provider', () => {
  const env = { ...process.env };
  const INSIGHTS_ENVS = [
    'META_INSIGHTS_SCOPES',
    'IG_LOGIN_INSIGHTS_SCOPES',
    'TIKTOK_INSIGHTS_SCOPES',
  ];
  const clearAll = () => {
    for (const k of INSIGHTS_ENVS) delete process.env[k];
    delete process.env.LINKEDIN_ORG_SCOPES;
  };
  afterEach(() => {
    process.env = { ...env };
  });

  it('asks for no read scope by default, on any network', () => {
    clearAll();
    for (const n of ['FACEBOOK', 'INSTAGRAM', 'INSTAGRAM_LOGIN', 'TIKTOK'] as const) {
      expect(scopesFor(n)).toEqual(NETWORK_OAUTH[n].scopes);
    }
    expect(scopesFor('FACEBOOK')).not.toContain('read_insights');
    expect(scopesFor('INSTAGRAM')).not.toContain('instagram_manage_insights');
    expect(scopesFor('TIKTOK')).not.toContain('user.info.stats');
  });

  it('META_INSIGHTS_SCOPES adds the page and IG read scopes, and only those', () => {
    clearAll();
    process.env.META_INSIGHTS_SCOPES = '1';
    expect(scopesFor('FACEBOOK')).toEqual([...NETWORK_OAUTH.FACEBOOK.scopes, 'read_insights']);
    expect(scopesFor('INSTAGRAM')).toEqual([
      ...NETWORK_OAUTH.INSTAGRAM.scopes,
      'instagram_manage_insights',
    ]);
    // One provider's flag must not turn on another's.
    expect(scopesFor('TIKTOK')).toEqual(NETWORK_OAUTH.TIKTOK.scopes);
    expect(scopesFor('INSTAGRAM_LOGIN')).toEqual(NETWORK_OAUTH.INSTAGRAM_LOGIN.scopes);
  });

  it('TIKTOK_INSIGHTS_SCOPES adds both of the scopes its two reads need', () => {
    clearAll();
    process.env.TIKTOK_INSIGHTS_SCOPES = '1';
    // video.list backs the per-post query; user.info.stats backs the follower count.
    expect(scopesFor('TIKTOK')).toEqual([
      ...NETWORK_OAUTH.TIKTOK.scopes,
      'video.list',
      'user.info.stats',
    ]);
  });

  it('IG_LOGIN_INSIGHTS_SCOPES is separate from the Meta one — different app', () => {
    clearAll();
    process.env.IG_LOGIN_INSIGHTS_SCOPES = '1';
    expect(scopesFor('INSTAGRAM_LOGIN')).toContain('instagram_business_manage_insights');
    expect(scopesFor('INSTAGRAM')).toEqual(NETWORK_OAUTH.INSTAGRAM.scopes);
  });

  it('never sends a scope twice if a provider folds one into its base grant', () => {
    clearAll();
    process.env.META_INSIGHTS_SCOPES = '1';
    const scopes = scopesFor('FACEBOOK');
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('reports what each network would gain, for the connect UI to explain', () => {
    clearAll();
    expect(insightsScopesFor('FACEBOOK')).toEqual({ scopes: ['read_insights'], enabled: false });
    process.env.META_INSIGHTS_SCOPES = '1';
    expect(insightsScopesFor('FACEBOOK').enabled).toBe(true);
    // X is the one network that already asks for what it reads.
    expect(insightsScopesFor('TWITTER')).toEqual({ scopes: [], enabled: true });
  });
});

/**
 * Client credentials: the table must be the WHOLE truth.
 *
 * `deploy.yml` ships the Google app as GOOGLE_OAUTH_CLIENT_ID/_SECRET, while the
 * GMB entry declared only the bare GOOGLE_CLIENT_ID/_SECRET and a hand-written
 * `if (n === 'GMB')` in the resolver quietly read the other spelling. A reader of
 * the table therefore got the wrong answer about which env var configures Google
 * — and the next network that needs two names would need a second such branch.
 *
 * The contract these pin: whatever env names a network's entry declares are
 * EXACTLY the names its credentials are read from, in the order declared.
 */
describe('client credentials resolve from the declared env names', () => {
  const env = { ...process.env };
  /** Every credential env name in the table — cleared so nothing leaks in. */
  const ALL_NAMES = OAUTH_NETWORKS.flatMap((n) => [
    ...[NETWORK_OAUTH[n].clientIdEnv].flat(),
    ...[NETWORK_OAUTH[n].clientSecretEnv].flat(),
    // Not declared today; listed so the "unconfigured" cases cannot pass by
    // accident on a machine where the operator's real Google app is exported.
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ]);
  const clearAll = () => {
    for (const k of ALL_NAMES) delete process.env[k];
  };
  afterEach(() => {
    process.env = { ...env };
  });

  it('declares BOTH Google spellings on GMB, highest precedence first', () => {
    expect([NETWORK_OAUTH.GMB.clientIdEnv].flat()).toEqual([
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_CLIENT_ID',
    ]);
    expect([NETWORK_OAUTH.GMB.clientSecretEnv].flat()).toEqual([
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_CLIENT_SECRET',
    ]);
  });

  it('reads every env name the table declares, for every network', () => {
    for (const n of OAUTH_NETWORKS) {
      for (const name of [NETWORK_OAUTH[n].clientIdEnv].flat()) {
        clearAll();
        process.env[name] = `id-via-${name}`;
        expect(clientId(n)).toBe(`id-via-${name}`);
      }
      for (const name of [NETWORK_OAUTH[n].clientSecretEnv].flat()) {
        clearAll();
        process.env[name] = `secret-via-${name}`;
        expect(clientSecret(n)).toBe(`secret-via-${name}`);
      }
    }
  });

  // The deployed reality: the workflow passes only the OAUTH-prefixed pair, so
  // this is the case that decides whether the Account Center offers Google at all.
  it('GMB is configured by the OAUTH-prefixed pair alone', () => {
    clearAll();
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsec';
    expect(clientId('GMB')).toBe('gid');
    expect(clientSecret('GMB')).toBe('gsec');
    expect(isOAuthConfigured('GMB')).toBe(true);
  });

  it('GMB is configured by the bare pair alone', () => {
    clearAll();
    process.env.GOOGLE_CLIENT_ID = 'gid2';
    process.env.GOOGLE_CLIENT_SECRET = 'gsec2';
    expect(isOAuthConfigured('GMB')).toBe(true);
  });

  it('prefers the OAUTH-prefixed name when both are set', () => {
    clearAll();
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'preferred';
    process.env.GOOGLE_CLIENT_ID = 'legacy';
    expect(clientId('GMB')).toBe('preferred');
  });

  it('is unconfigured when neither spelling is set', () => {
    clearAll();
    expect(clientId('GMB')).toBeUndefined();
    expect(isOAuthConfigured('GMB')).toBe(false);
  });

  // A blank/whitespace value is a MIS-configuration, not a configuration: it
  // would otherwise pass the gate and fail at the provider with an opaque error.
  it('treats a blank or whitespace value as unset, and falls through to the next name', () => {
    clearAll();
    process.env.META_APP_ID = '   ';
    expect(clientId('FACEBOOK')).toBeUndefined();
    expect(isOAuthConfigured('FACEBOOK')).toBe(false);
    process.env.GOOGLE_OAUTH_CLIENT_ID = '  ';
    process.env.GOOGLE_CLIENT_ID = 'legacy';
    expect(clientId('GMB')).toBe('legacy');
  });
});
