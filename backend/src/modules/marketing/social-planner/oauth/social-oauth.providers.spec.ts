import * as fetchMod from '../../../../common/util/safe-fetch';
import { metaProvider, linkedinProvider, tiktokProvider, buildAuthorizeUrl } from './social-oauth.providers';

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

  it('LinkedIn: space-delimited scopes incl. org share', () => {
    process.env.LINKEDIN_CLIENT_ID = 'LIID';
    process.env.API_URL = 'https://api.x/api';
    const url = buildAuthorizeUrl('LINKEDIN', 'S');
    expect(url).toContain('client_id=LIID');
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('w_organization_social');
    expect(decoded).toContain('w_member_social');
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
