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
});
