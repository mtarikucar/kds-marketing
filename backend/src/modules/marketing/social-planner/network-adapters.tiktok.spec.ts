import { isNetworkConfigured, publishToNetwork } from './network-adapters';

describe('network-adapters — TikTok', () => {
  const account = { id: 'a1', network: 'TIKTOK', externalId: 'tt-1', accessToken: 'sealed' } as any;
  const KEY = process.env.TIKTOK_CLIENT_KEY;
  const SECRET = process.env.TIKTOK_CLIENT_SECRET;

  afterEach(() => {
    if (KEY === undefined) delete process.env.TIKTOK_CLIENT_KEY;
    else process.env.TIKTOK_CLIENT_KEY = KEY;
    if (SECRET === undefined) delete process.env.TIKTOK_CLIENT_SECRET;
    else process.env.TIKTOK_CLIENT_SECRET = SECRET;
  });

  it('isNetworkConfigured(TIKTOK) reflects the TIKTOK_CLIENT_* env vars', () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    expect(isNetworkConfigured('TIKTOK')).toBe(false);
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
    expect(isNetworkConfigured('TIKTOK')).toBe(true);
  });

  it('dispatches TIKTOK and is inert (no network call) when not configured', async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    const res = await publishToNetwork(account, 'hello', ['https://cdn.example/v.mp4']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('TikTok not configured');
  });
});
