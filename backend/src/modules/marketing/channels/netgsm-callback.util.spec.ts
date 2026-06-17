import { netgsmMoToken, verifyNetgsmMoToken, netgsmMoCallbackUrl } from './netgsm-callback.util';

/**
 * NetGSM does not sign its inbound (MO) callbacks, so we protect the public MO
 * URL with an unguessable per-channel token derived from MARKETING_SECRET_KEY.
 * The channelId travels in the URL; the token makes that URL unforgeable.
 */
describe('netgsm MO callback token', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('is deterministic per channel and verifies its own token', () => {
    const t = netgsmMoToken('chan-1');
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(netgsmMoToken('chan-1')).toBe(t);
    expect(verifyNetgsmMoToken('chan-1', t)).toBe(true);
  });

  it('differs across channels and rejects another channel’s token', () => {
    const t1 = netgsmMoToken('chan-1');
    const t2 = netgsmMoToken('chan-2');
    expect(t1).not.toBe(t2);
    expect(verifyNetgsmMoToken('chan-2', t1)).toBe(false);
  });

  it('rejects an empty or garbage token without throwing', () => {
    expect(verifyNetgsmMoToken('chan-1', '')).toBe(false);
    expect(verifyNetgsmMoToken('chan-1', 'deadbeef')).toBe(false);
  });

  it('rejects (does not throw) when the secret key is absent', () => {
    delete process.env.MARKETING_SECRET_KEY;
    expect(verifyNetgsmMoToken('chan-1', 'whatever')).toBe(false);
  });
});

/**
 * The MO callback URL the operator pastes into NetGSM's "İnteraktif SMS → URL
 * Adresine Yönlendir" panel. It embeds the channelId and the per-channel token
 * so NetGSM's unsigned callback is still unforgeable.
 */
describe('netgsmMoCallbackUrl', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('builds the public MO URL with the per-channel token', () => {
    const url = netgsmMoCallbackUrl('https://m.example.com', 'chan-1');
    expect(url).toBe(
      `https://m.example.com/api/public/channels/netgsm/chan-1/${netgsmMoToken('chan-1')}/mo`,
    );
  });

  it('strips a trailing slash on the base URL', () => {
    const url = netgsmMoCallbackUrl('https://m.example.com/', 'chan-1');
    expect(url).not.toContain('.com//api');
  });

  it('returns null without a base URL or without the secret key', () => {
    expect(netgsmMoCallbackUrl('', 'chan-1')).toBeNull();
    expect(netgsmMoCallbackUrl(undefined, 'chan-1')).toBeNull();
    delete process.env.MARKETING_SECRET_KEY;
    expect(netgsmMoCallbackUrl('https://m.example.com', 'chan-1')).toBeNull();
  });
});
