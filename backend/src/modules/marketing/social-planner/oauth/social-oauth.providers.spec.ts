import * as fetchMod from '../../../../common/util/safe-fetch';
import {
  metaProvider,
  linkedinProvider,
  tiktokProvider,
  twitterProvider,
  pinterestProvider,
  gmbProvider,
  instagramLoginProvider,
  buildAuthorizeUrl,
} from './social-oauth.providers';

jest.mock('../../../../common/util/safe-fetch');
const mockFetch = fetchMod.safeFetch as jest.Mock;
const res = (body: any, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as any;

describe('buildAuthorizeUrl', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('Meta: includes client_id, scope, redirect, state', () => {
    process.env.META_APP_ID = 'APPID';
    process.env.API_URL = 'https://api.x/api';
    const url = buildAuthorizeUrl('FACEBOOK', 'STATE123');
    expect(url).toContain('client_id=APPID');
    expect(url).toContain('state=STATE123');
    expect(decodeURIComponent(url)).toContain('pages_manage_posts');
    expect(decodeURIComponent(url)).toContain('/marketing/social/oauth/facebook/callback');
  });

  it('Meta: uses config_id (FLB) and omits scope when META_LOGIN_CONFIG_ID is set', () => {
    process.env.META_APP_ID = 'APPID';
    process.env.API_URL = 'https://api.x/api';
    process.env.META_LOGIN_CONFIG_ID = 'cfg-123';
    const url = buildAuthorizeUrl('FACEBOOK', 'S');
    expect(url).toContain('config_id=cfg-123');
    expect(url).not.toContain('scope=');
    delete process.env.META_LOGIN_CONFIG_ID;
  });

  it('TikTok: uses client_key instead of client_id', () => {
    process.env.TIKTOK_CLIENT_KEY = 'TTKEY';
    process.env.API_URL = 'https://api.x/api';
    const url = buildAuthorizeUrl('TIKTOK', 'S');
    expect(url).toContain('client_key=TTKEY');
    expect(url).not.toContain('client_id=');
    expect(decodeURIComponent(url)).toContain('video.publish');
  });

  it('LinkedIn: default requests only self-serve member scopes (org scopes need CMA approval)', () => {
    process.env.LINKEDIN_CLIENT_ID = 'LIID';
    process.env.API_URL = 'https://api.x/api';
    delete process.env.LINKEDIN_ORG_SCOPES;
    const url = buildAuthorizeUrl('LINKEDIN', 'S');
    expect(url).toContain('client_id=LIID');
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('w_member_social');
    expect(decoded).not.toContain('w_organization_social');
    expect(decoded).not.toContain('r_organization_social');
  });

  it('LinkedIn: LINKEDIN_ORG_SCOPES=1 adds the org scopes back (CMA-granted app)', () => {
    process.env.LINKEDIN_CLIENT_ID = 'LIID';
    process.env.API_URL = 'https://api.x/api';
    process.env.LINKEDIN_ORG_SCOPES = '1';
    const url = buildAuthorizeUrl('LINKEDIN', 'S');
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('w_member_social');
    expect(decoded).toContain('w_organization_social');
    expect(decoded).toContain('r_organization_social');
  });

  it('X/Twitter: adds the PKCE S256 challenge when one is supplied', () => {
    process.env.X_CLIENT_ID = 'XID';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    const url = buildAuthorizeUrl('TWITTER', 'S', 'CHALLENGE123');
    expect(url).toContain('client_id=XID');
    expect(url).toContain('code_challenge=CHALLENGE123');
    expect(url).toContain('code_challenge_method=S256');
    expect(decodeURIComponent(url)).toContain('tweet.write');
    expect(decodeURIComponent(url)).toContain('/marketing/social/oauth/twitter/callback');
  });

  it('Pinterest: comma-delimited scopes + board write', () => {
    process.env.PINTEREST_APP_ID = 'PID';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    const url = buildAuthorizeUrl('PINTEREST', 'S');
    expect(url).toContain('client_id=PID');
    expect(decodeURIComponent(url)).toContain('pins:write');
  });

  it('GMB: Google authorize with business.manage + offline access', () => {
    process.env.GOOGLE_CLIENT_ID = 'GID';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    const url = buildAuthorizeUrl('GMB', 'S');
    expect(url).toContain('client_id=GID');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(decodeURIComponent(url)).toContain('business.manage');
  });

  it('Instagram-Login: instagram.com authorize, client_id, comma scopes, response_type=code, state', () => {
    process.env.INSTAGRAM_APP_ID = 'IGAPP';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    const url = buildAuthorizeUrl('INSTAGRAM_LOGIN', 'STATE9');
    expect(url).toContain('https://www.instagram.com/oauth/authorize');
    expect(url).toContain('client_id=IGAPP');
    expect(url).not.toContain('client_key=');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=STATE9');
    const decoded = decodeURIComponent(url);
    // comma-delimited scopes incl. the publish scope
    expect(decoded).toContain('instagram_business_basic,instagram_business_content_publish');
    expect(decoded).toContain('/marketing/social/oauth/instagram_login/callback');
    // not the FB config_id flow
    expect(url).not.toContain('config_id=');
  });
});

describe('twitterProvider (X, PKCE)', () => {
  beforeEach(() => {
    process.env.X_CLIENT_ID = 'xid';
    process.env.X_CLIENT_SECRET = 'xsecret';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    mockFetch.mockReset();
  });

  it('exchangeCode sends the code_verifier + Basic auth, returns tokens', async () => {
    mockFetch.mockResolvedValueOnce(res({ access_token: 'xt', refresh_token: 'xr', expires_in: 7200 }));
    const r = await twitterProvider.exchangeCode('TWITTER', 'CODE', 'VERIFIER123');
    expect(r.accessToken).toBe('xt');
    expect(r.refreshToken).toBe('xr');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.body).toContain('code_verifier=VERIFIER123');
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it('listAssets returns the authenticated X account', async () => {
    mockFetch.mockResolvedValueOnce(res({ data: { id: 'u1', username: 'acme', name: 'Acme' } }));
    const assets = await twitterProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ externalId: 'u1', accountType: 'TWITTER' });
  });
});

describe('pinterestProvider', () => {
  beforeEach(() => {
    process.env.PINTEREST_APP_ID = 'pid';
    process.env.PINTEREST_APP_SECRET = 'psecret';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    mockFetch.mockReset();
  });

  it('exchangeCode uses Basic auth + returns tokens', async () => {
    mockFetch.mockResolvedValueOnce(res({ access_token: 'pt', refresh_token: 'pr', expires_in: 2592000 }));
    const r = await pinterestProvider.exchangeCode('PINTEREST', 'CODE');
    expect(r.accessToken).toBe('pt');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it('listAssets returns one asset per board', async () => {
    mockFetch.mockResolvedValueOnce(
      res({ items: [{ id: 'b1', name: 'Recipes' }, { id: 'b2', name: 'Promos' }] }),
    );
    const assets = await pinterestProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ externalId: 'b1', accountType: 'PINTEREST_BOARD' });
  });
});

describe('gmbProvider (Google Business Profile)', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    mockFetch.mockReset();
  });

  it('listAssets walks accounts → locations into full resource ids', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ accounts: [{ name: 'accounts/123' }] }))
      .mockResolvedValueOnce(res({ locations: [{ name: 'locations/456', title: 'Acme Store' }] }));
    const assets = await gmbProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      externalId: 'accounts/123/locations/456',
      accountType: 'GMB_LOCATION',
    });
  });

  it("a single account's location failure doesn't abort the rest", async () => {
    mockFetch
      .mockResolvedValueOnce(res({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }] }))
      .mockRejectedValueOnce(new Error('403'))
      .mockResolvedValueOnce(res({ locations: [{ name: 'locations/9', title: 'Store 2' }] }));
    const assets = await gmbProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0].externalId).toBe('accounts/2/locations/9');
  });
});

describe('linkedinProvider.listAssets', () => {
  beforeEach(() => {
    process.env.LINKEDIN_CLIENT_ID = 'a';
    process.env.LINKEDIN_CLIENT_SECRET = 'b';
    mockFetch.mockReset();
  });

  it('returns the member profile and admined organizations', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ sub: 'urn-sub-1', name: 'Jane' })) // userinfo
      .mockResolvedValueOnce(
        res({
          elements: [
            { organization: 'urn:li:organization:999', 'organization~': { localizedName: 'Acme Inc' } },
          ],
        }),
      ); // organizationAcls
    const assets = await linkedinProvider.listAssets('TOKEN');
    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: 'urn-sub-1', accountType: 'LI_PERSON' }),
        expect.objectContaining({ externalId: '999', accountType: 'LI_ORG', displayName: 'Acme Inc' }),
      ]),
    );
  });

  it('still returns the profile when the org call fails', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ sub: 'urn-sub-1', name: 'Jane' }))
      .mockRejectedValueOnce(new Error('403'));
    const assets = await linkedinProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0].accountType).toBe('LI_PERSON');
  });
});

describe('tiktokProvider', () => {
  beforeEach(() => {
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
    mockFetch.mockReset();
  });

  it('exchangeCode returns token + refresh + expiry', async () => {
    mockFetch.mockResolvedValueOnce(
      res({ access_token: 'tt', refresh_token: 'rt', expires_in: 86400, open_id: 'oid' }),
    );
    const r = await tiktokProvider.exchangeCode('TIKTOK', 'CODE');
    expect(r.accessToken).toBe('tt');
    expect(r.refreshToken).toBe('rt');
    expect(r.expiresAt).toBeInstanceOf(Date);
  });

  it('listAssets returns the single TikTok account', async () => {
    mockFetch.mockResolvedValueOnce(res({ data: { user: { open_id: 'oid', display_name: 'Acme' } } }));
    const assets = await tiktokProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ externalId: 'oid', accountType: 'TIKTOK' });
  });
});

describe('instagramLoginProvider (direct Instagram Login)', () => {
  beforeEach(() => {
    process.env.INSTAGRAM_APP_ID = 'igapp';
    process.env.INSTAGRAM_APP_SECRET = 'igsecret';
    process.env.PUBLIC_BASE_URL = 'https://api.x';
    mockFetch.mockReset();
  });

  it('exchangeCode does the 2-step exchange, strips a trailing #_, returns the long token as access+refresh', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ access_token: 'short', user_id: 'u9', permissions: 'x' })) // short-lived
      .mockResolvedValueOnce(res({ access_token: 'LONGTOK', token_type: 'bearer', expires_in: 5184000 })); // long-lived
    const r = await instagramLoginProvider.exchangeCode('INSTAGRAM_LOGIN', 'CODE123#_');
    expect(r.accessToken).toBe('LONGTOK');
    expect(r.refreshToken).toBe('LONGTOK');
    expect(r.expiresAt).toBeInstanceOf(Date);

    // 1st call: POST short-lived token, code with the trailing #_ stripped.
    const [url0, init0] = mockFetch.mock.calls[0];
    expect(url0).toBe('https://api.instagram.com/oauth/access_token');
    expect(init0.method).toBe('POST');
    expect(init0.body).toContain('grant_type=authorization_code');
    expect(init0.body).toContain('code=CODE123');
    expect(init0.body).not.toContain('%23_'); // no encoded #_
    // 2nd call: GET long-lived exchange on graph.instagram.com.
    const [url1] = mockFetch.mock.calls[1];
    expect(url1).toContain('https://graph.instagram.com/access_token');
    expect(url1).toContain('grant_type=ig_exchange_token');
    expect(url1).toContain('access_token=short');
  });

  it('exchangeCode throws when the short-lived exchange fails', async () => {
    mockFetch.mockResolvedValueOnce(res({ error_message: 'bad code' }, false));
    await expect(instagramLoginProvider.exchangeCode('INSTAGRAM_LOGIN', 'CODE')).rejects.toThrow('bad code');
  });

  it('refresh re-issues the access token via refresh_access_token', async () => {
    mockFetch.mockResolvedValueOnce(res({ access_token: 'NEWTOK', token_type: 'bearer', expires_in: 5184000 }));
    const r = await instagramLoginProvider.refresh!('OLDTOK');
    expect(r.accessToken).toBe('NEWTOK');
    expect(r.refreshToken).toBe('NEWTOK');
    expect(r.expiresAt).toBeInstanceOf(Date);
    const [url0] = mockFetch.mock.calls[0];
    expect(url0).toContain('https://graph.instagram.com/refresh_access_token');
    expect(url0).toContain('grant_type=ig_refresh_token');
    expect(url0).toContain('access_token=OLDTOK');
  });

  it('listAssets parses /me into one IG_DIRECT asset', async () => {
    mockFetch.mockResolvedValueOnce(res({ user_id: '17841400000', username: 'acme' }));
    const assets = await instagramLoginProvider.listAssets('TOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      externalId: '17841400000',
      accountType: 'IG_DIRECT',
      displayName: 'acme (Instagram)',
      token: 'TOKEN',
    });
    const [url0] = mockFetch.mock.calls[0];
    expect(url0).toContain('https://graph.instagram.com/me');
    expect(url0).toContain('fields=user_id');
  });
});

describe('metaProvider.exchangeCode', () => {
  beforeEach(() => {
    process.env.META_APP_ID = 'a';
    process.env.META_APP_SECRET = 'b';
    process.env.API_URL = 'https://api.x/api';
    mockFetch.mockReset();
  });

  it('exchanges then upgrades to a long-lived token with expiry', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ access_token: 'short' }))
      .mockResolvedValueOnce(res({ access_token: 'long', expires_in: 5184000 }));
    const r = await metaProvider.exchangeCode('FACEBOOK', 'CODE');
    expect(r.accessToken).toBe('long');
    expect(r.expiresAt).toBeInstanceOf(Date);
  });

  it('throws when the short-lived exchange fails', async () => {
    mockFetch.mockResolvedValueOnce(res({ error: { message: 'bad code' } }, false));
    await expect(metaProvider.exchangeCode('FACEBOOK', 'CODE')).rejects.toThrow('bad code');
  });
});

describe('metaProvider.listAssets', () => {
  beforeEach(() => {
    process.env.META_APP_ID = 'a';
    process.env.META_APP_SECRET = 'b';
    mockFetch.mockReset();
  });

  it('returns pages plus their IG business accounts', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: 'P1', name: 'Acme', access_token: 'pt1' }] }))
      .mockResolvedValueOnce(res({ instagram_business_account: { id: 'IG1', username: 'acme' } }));
    const assets = await metaProvider.listAssets('USERTOKEN');
    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: 'P1', accountType: 'PAGE', token: 'pt1' }),
        expect.objectContaining({ externalId: 'IG1', accountType: 'IG_BUSINESS', token: 'pt1' }),
      ]),
    );
  });

  it('includes a page even when it has no linked IG account', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: 'P2', name: 'NoIG', access_token: 'pt2' }] }))
      .mockResolvedValueOnce(res({ name: 'NoIG' })); // no instagram_business_account
    const assets = await metaProvider.listAssets('USERTOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ externalId: 'P2', accountType: 'PAGE' });
  });

  it('discovers ad accounts and WhatsApp numbers when those scopes are granted', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: 'P1', name: 'Acme', access_token: 'pt1' }] })) // pages
      .mockResolvedValueOnce(res({})) // IG (none)
      .mockResolvedValueOnce(res({ data: [{ account_id: '123', name: 'Biz', currency: 'USD', account_status: 1 }] })) // /me/adaccounts
      .mockResolvedValueOnce(res({ data: [{ id: 'B1', name: 'Biz' }] })) // /me/businesses
      .mockResolvedValueOnce(res({ data: [{ id: 'WABA1', name: 'WA' }] })) // owned WABAs
      .mockResolvedValueOnce(res({ data: [{ id: 'PN1', display_phone_number: '+90', verified_name: 'Acme' }] })); // phone_numbers
    const assets = await metaProvider.listAssets('USERTOKEN');
    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: 'P1', accountType: 'PAGE' }),
        expect.objectContaining({ externalId: '123', accountType: 'AD_ACCOUNT', meta: expect.objectContaining({ currency: 'USD' }) }),
        expect.objectContaining({ externalId: 'PN1', accountType: 'WHATSAPP_NUMBER', meta: expect.objectContaining({ phoneNumberId: 'PN1' }) }),
      ]),
    );
  });

  it('still returns pages when ad-account/WhatsApp scopes are missing (graceful)', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ data: [{ id: 'P1', name: 'Acme', access_token: 'pt1' }] })) // pages
      .mockResolvedValueOnce(res({})) // IG none
      .mockResolvedValueOnce(res({ error: { message: 'no ads_read' } }, false)) // /me/adaccounts 4xx
      .mockResolvedValueOnce(res({ error: { message: 'no wa' } }, false)); // /me/businesses 4xx
    const assets = await metaProvider.listAssets('USERTOKEN');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ externalId: 'P1', accountType: 'PAGE' });
  });
});
