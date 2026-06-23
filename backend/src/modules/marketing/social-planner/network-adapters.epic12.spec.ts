import { isNetworkConfigured, publishToNetwork } from './network-adapters';

/**
 * Epic 12 (needs-external) — X/Twitter, Pinterest, Google Business Profile
 * publish adapters. They are INERT until their platform-app env vars are set:
 * isNetworkConfigured gates each, and an unconfigured publish makes no network
 * call and returns a clear "not configured" error.
 */
describe('network-adapters — Epic 12 inert networks', () => {
  const SAVED: Record<string, string | undefined> = {
    X_CLIENT_ID: process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
    PINTEREST_APP_ID: process.env.PINTEREST_APP_ID,
    PINTEREST_APP_SECRET: process.env.PINTEREST_APP_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };
  const clearAll = () => Object.keys(SAVED).forEach((k) => delete process.env[k]);
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('TWITTER gates on X_CLIENT_* and is inert without creds', async () => {
    clearAll();
    expect(isNetworkConfigured('TWITTER')).toBe(false);
    process.env.X_CLIENT_ID = 'i';
    process.env.X_CLIENT_SECRET = 's';
    expect(isNetworkConfigured('TWITTER')).toBe(true);
    clearAll();
    const res = await publishToNetwork({ id: 'a', network: 'TWITTER', externalId: 'x', accessToken: 'sealed' } as any, 'hi', []);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('X/Twitter not configured');
  });

  it('PINTEREST gates on PINTEREST_APP_* and is inert without creds', async () => {
    clearAll();
    expect(isNetworkConfigured('PINTEREST')).toBe(false);
    process.env.PINTEREST_APP_ID = 'i';
    process.env.PINTEREST_APP_SECRET = 's';
    expect(isNetworkConfigured('PINTEREST')).toBe(true);
    clearAll();
    const res = await publishToNetwork({ id: 'a', network: 'PINTEREST', externalId: 'board-1', accessToken: 'sealed' } as any, 'hi', ['https://cdn/x.jpg']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Pinterest not configured');
  });

  it('GMB gates on GOOGLE_CLIENT_* and is inert without creds', async () => {
    clearAll();
    expect(isNetworkConfigured('GMB')).toBe(false);
    process.env.GOOGLE_CLIENT_ID = 'i';
    process.env.GOOGLE_CLIENT_SECRET = 's';
    expect(isNetworkConfigured('GMB')).toBe(true);
    clearAll();
    const res = await publishToNetwork({ id: 'a', network: 'GMB', externalId: 'accounts/1/locations/2', accessToken: 'sealed' } as any, 'hi', []);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Google Business Profile not configured');
  });

  it('an unknown network is still rejected', async () => {
    const res = await publishToNetwork({ id: 'a', network: 'MYSPACE', externalId: 'x', accessToken: 's' } as any, 'hi', []);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown network');
  });
});
