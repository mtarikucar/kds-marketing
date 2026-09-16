import { listUnsubscribeHeaders } from './list-unsubscribe';

/**
 * RFC 8058 one-click unsubscribe.
 *
 * The POST endpoint has existed for a long time (`@Post('u/:token')`, throttled,
 * documented as serving One-Click) and the GET is a confirm page precisely so a
 * mail-security scanner cannot unsubscribe anybody by prefetching links. What
 * never existed was the pair of HEADERS that makes a client offer its own
 * Unsubscribe button — so Gmail and Yahoo, who have required them from bulk
 * senders since February 2024, were never told this mail was bulk.
 *
 * One pure function owns the wire format, because the same pair has to come out
 * of two unrelated transports (the workspace's SMTP adapter and the platform
 * mailer) and two encodings of the same header is how they drift.
 */
describe('listUnsubscribeHeaders', () => {
  const URL = 'https://m.test/api/public/u/tok-1';

  it('emits the RFC 8058 pair, with the URI in angle brackets', () => {
    // A bare URL is not a valid List-Unsubscribe value: the field is a list of
    // <URI> forms, and clients that parse strictly ignore an unbracketed one.
    expect(listUnsubscribeHeaders(URL)).toEqual({
      'List-Unsubscribe': `<${URL}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('answers nothing when there is no URL — a one-to-one reply must never claim to be bulk', () => {
    // This is the whole opt-in: the inbox reply path passes nothing, so it
    // cannot accidentally acquire a header that says "this is a mailing list".
    expect(listUnsubscribeHeaders(undefined)).toEqual({});
    expect(listUnsubscribeHeaders('')).toEqual({});
    expect(listUnsubscribeHeaders('   ')).toEqual({});
  });

  it('refuses a non-http(s) URI rather than emitting a header a client cannot use', () => {
    expect(listUnsubscribeHeaders('javascript:alert(1)')).toEqual({});
    expect(listUnsubscribeHeaders('/api/public/u/tok-1')).toEqual({});
  });
});
