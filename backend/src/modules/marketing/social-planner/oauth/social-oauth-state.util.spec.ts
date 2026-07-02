import { signState, verifyState } from './social-oauth-state.util';

describe('social oauth state', () => {
  const orig = process.env.MARKETING_SECRET_KEY;
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = 'x'.repeat(64);
  });
  afterAll(() => {
    process.env.MARKETING_SECRET_KEY = orig;
  });

  it('round-trips workspace + network', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK' });
    const v = verifyState(s);
    expect(v).toMatchObject({ workspaceId: 'ws1', network: 'FACEBOOK' });
  });

  it('rejects a tampered signature', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK' });
    expect(verifyState(s.slice(0, -2) + 'aa')).toBeNull();
  });

  it('rejects an expired token', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK' }, -1);
    expect(verifyState(s)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyState('not-a-token')).toBeNull();
    expect(verifyState('')).toBeNull();
  });

  it('two states have distinct nonces', () => {
    const a = verifyState(signState({ workspaceId: 'ws1', network: 'FACEBOOK' }));
    const b = verifyState(signState({ workspaceId: 'ws1', network: 'FACEBOOK' }));
    expect(a!.nonce).not.toBe(b!.nonce);
  });

  it('round-trips the connect origin', () => {
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK', origin: 'channels' });
    expect(verifyState(s)).toMatchObject({ origin: 'channels' });
  });

  it('omits origin when not provided (back-compat)', () => {
    const v = verifyState(signState({ workspaceId: 'ws1', network: 'FACEBOOK' }));
    expect(v!.origin).toBeUndefined();
  });

  it('a tampered origin fails the signature (in-HMAC)', () => {
    // Reuse a real signature but swap the body to claim origin=channels — the
    // HMAC no longer matches, so the whole state is rejected (can't be forged).
    const s = signState({ workspaceId: 'ws1', network: 'FACEBOOK', origin: 'social' });
    const sig = s.split('.')[1];
    const b64url = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forgedBody = b64url({
      workspaceId: 'ws1', network: 'FACEBOOK', nonce: 'n', exp: Date.now() + 10_000, origin: 'channels',
    });
    expect(verifyState(`${forgedBody}.${sig}`)).toBeNull();
  });
});
