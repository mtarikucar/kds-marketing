import { createHmac } from 'node:crypto';
import { parseMetaSignedRequest } from './meta-signed-request.util';

const SECRET = 'app-secret-for-tests';

/** Build a real Meta `signed_request` (`base64url(sig).base64url(json)`). */
function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
}

describe('parseMetaSignedRequest', () => {
  const now = Math.floor(Date.now() / 1000);
  const good = { algorithm: 'HMAC-SHA256', issued_at: now, user_id: '1234567890' };

  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.META_APP_SECRET;
  });

  it('accepts a correctly signed request and returns the user id', () => {
    expect(parseMetaSignedRequest(sign(good))).toEqual({ ok: true, userId: '1234567890', reason: null });
  });

  it('REFUSES a request signed with the wrong secret (forgery)', () => {
    const forged = sign(good, 'not-the-app-secret');
    expect(parseMetaSignedRequest(forged)).toEqual({ ok: false, userId: null, reason: 'bad_signature' });
  });

  it('REFUSES a request whose payload was tampered with after signing', () => {
    const [sig] = sign(good).split('.');
    const swapped = Buffer.from(
      JSON.stringify({ ...good, user_id: '9999999999' }),
    ).toString('base64url');
    expect(parseMetaSignedRequest(`${sig}.${swapped}`)).toEqual({ ok: false, userId: null, reason: 'bad_signature' });
  });

  it('refuses a non-HMAC-SHA256 algorithm (downgrade attempt)', () => {
    expect(parseMetaSignedRequest(sign({ ...good, algorithm: 'none' }))).toEqual({
      ok: false,
      userId: null,
      reason: 'bad_algorithm',
    });
  });

  it('refuses a malformed request (no dot, not base64, not json, no user id)', () => {
    expect(parseMetaSignedRequest('nodothere')).toEqual({ ok: false, userId: null, reason: 'malformed' });
    const notJson = Buffer.from('hello').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(notJson).digest('base64url');
    expect(parseMetaSignedRequest(`${sig}.${notJson}`)).toEqual({ ok: false, userId: null, reason: 'malformed' });
    expect(parseMetaSignedRequest(sign({ algorithm: 'HMAC-SHA256', issued_at: now }))).toEqual({
      ok: false,
      userId: null,
      reason: 'malformed',
    });
  });

  it('refuses everything when META_APP_SECRET is unset — an unconfigured app must not accept deletions', () => {
    delete process.env.META_APP_SECRET;
    expect(parseMetaSignedRequest(sign(good))).toEqual({ ok: false, userId: null, reason: 'not_configured' });
  });

  it('refuses a stale request (replay window)', () => {
    const stale = { ...good, issued_at: now - 60 * 60 * 24 * 8 };
    expect(parseMetaSignedRequest(sign(stale))).toEqual({ ok: false, userId: null, reason: 'expired' });
  });
});
