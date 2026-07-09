import {
  mintRecordingProxyToken,
  recordingProxyUrl,
  verifyRecordingProxyToken,
} from './recording-proxy-token.util';

/**
 * HIGH fix round 1 — the recording proxy route's short-lived, call-scoped
 * HMAC token. Mirrors netgsm-webhook.util.spec.ts's coverage shape (own
 * verify, differs across scope, tamper-proof) plus TTL expiry, which the
 * webhook token doesn't have.
 */
describe('recording proxy token', () => {
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('mints a token that verifies for the exact workspace + call it was minted for', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1');
    expect(verifyRecordingProxyToken('ws-1', 'call-1', token)).toBe(true);
  });

  it('rejects the token when replayed against a different call', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1');
    expect(verifyRecordingProxyToken('ws-1', 'call-2', token)).toBe(false);
  });

  it('rejects the token when replayed against a different workspace', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1');
    expect(verifyRecordingProxyToken('ws-2', 'call-1', token)).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1', -1); // already expired
    expect(verifyRecordingProxyToken('ws-1', 'call-1', token)).toBe(false);
  });

  it('rejects a forged exp (tampering with the clear-text timestamp invalidates the HMAC)', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1');
    const [, mac] = token.split('.');
    const forged = `${Date.now() + 10 * 60 * 1000}.${mac}`; // pushed exp further out, same mac
    expect(verifyRecordingProxyToken('ws-1', 'call-1', forged)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyRecordingProxyToken('ws-1', 'call-1', '')).toBe(false);
    expect(verifyRecordingProxyToken('ws-1', 'call-1', 'garbage')).toBe(false);
    expect(verifyRecordingProxyToken('ws-1', 'call-1', 'not-a-number.deadbeef')).toBe(false);
  });

  it('never throws when MARKETING_SECRET_KEY is unset', () => {
    const saved = process.env.MARKETING_SECRET_KEY;
    delete process.env.MARKETING_SECRET_KEY;
    expect(() => verifyRecordingProxyToken('ws-1', 'call-1', 'x.y')).not.toThrow();
    expect(verifyRecordingProxyToken('ws-1', 'call-1', 'x.y')).toBe(false);
    process.env.MARKETING_SECRET_KEY = saved;
  });

  it('builds the proxy URL from PUBLIC_BASE_URL, workspaceId, callId and the token', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1');
    const url = recordingProxyUrl('https://marketing.example.com/', 'ws-1', 'call-1', token);
    expect(url).toBe(`https://marketing.example.com/api/public/telephony/recording/ws-1/call-1/${token}`);
  });

  it('falls back to a root-relative path when PUBLIC_BASE_URL is unset', () => {
    const token = mintRecordingProxyToken('ws-1', 'call-1');
    const url = recordingProxyUrl(undefined, 'ws-1', 'call-1', token);
    expect(url).toBe(`/api/public/telephony/recording/ws-1/call-1/${token}`);
  });
});
