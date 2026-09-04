import {
  buildRfc822,
  exchangeCodeForTokens,
  fetchConnectedAddress,
  needsRefresh,
  refreshAccessToken,
  sendViaOAuth,
} from './email-oauth.sender';

const okJson = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe('sending on a connected mailbox behalf', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GOOGLE_MAIL_CLIENT_ID;
    delete process.env.GOOGLE_MAIL_CLIENT_SECRET;
  });

  describe('buildRfc822', () => {
    it('encodes the subject, because this product writes Turkish', () => {
      // A bare 8-bit Subject header is out of spec: some servers pass it and
      // some mangle it, and the ones that mangle it do so without complaining.
      const raw = buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 'Ücretsiz çekirdek', text: 'merhaba' });
      expect(raw).toContain('Subject: =?UTF-8?B?');
      expect(raw).not.toContain('Ücretsiz');
      // The decoded header must still be the subject the caller passed.
      const b64 = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(raw)![1];
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Ücretsiz çekirdek');
    });

    it('sends the body base64 so a Turkish body survives too', () => {
      const raw = buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 'ığüşöç' });
      expect(raw).toContain('Content-Transfer-Encoding: base64');
      const body = raw.split('\r\n\r\n')[1];
      expect(Buffer.from(body, 'base64').toString('utf8')).toBe('ığüşöç');
    });
  });

  describe('Google', () => {
    it('posts base64URL to the Gmail API — not SMTP, and not standard base64', async () => {
      // Standard base64 padding is rejected by the API, and SMTP would need the
      // restricted scope this whole design exists to avoid.
      const fetchMock = jest.fn().mockResolvedValue(okJson({ id: 'msg-1' }));
      global.fetch = fetchMock as never;
      const r = await sendViaOAuth({
        provider: 'GOOGLE', accessToken: 'tok', from: 'a@b.com', to: 'c@d.com',
        subject: 'hi', text: 'x'.repeat(5),
      });
      expect(r).toMatchObject({ ok: true, externalId: 'msg-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      const raw = JSON.parse((init as RequestInit).body as string).raw;
      expect(raw).not.toMatch(/[+/=]/);
    });

    it("reports the provider's own words, not a paraphrase", async () => {
      // This string is what the operator pastes into a support thread.
      global.fetch = jest.fn().mockResolvedValue(
        okJson({ error: { message: 'Request had insufficient authentication scopes.' } }, 403),
      ) as never;
      const r = await sendViaOAuth({
        provider: 'GOOGLE', accessToken: 't', from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't',
      });
      expect(r).toMatchObject({ ok: false, error: 'Gmail 403: Request had insufficient authentication scopes.' });
    });
  });

  describe('Microsoft', () => {
    it('posts to Graph sendMail and does not invent a message id', async () => {
      // Graph answers 202 with an empty body. Returning a fabricated id would
      // put a value on the row that matches nothing.
      global.fetch = jest.fn().mockResolvedValue(okJson({}, 202)) as never;
      const r = await sendViaOAuth({
        provider: 'MICROSOFT', accessToken: 't', from: 'a@b.com', to: 'c@d.com', subject: 's', text: 'body',
      });
      expect(r).toMatchObject({ ok: true, externalId: null });
    });
  });

  describe('refreshAccessToken', () => {
    it('refuses before the network when the app is not registered here', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as never;
      const r = await refreshAccessToken('GOOGLE', 'rt');
      expect(r).toMatchObject({ error: expect.stringContaining('not configured') });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a rotated refresh token, and does not clobber one that was not rotated', async () => {
      process.env.GOOGLE_MAIL_CLIENT_ID = 'id';
      process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
      global.fetch = jest.fn().mockResolvedValue(okJson({ access_token: 'new', expires_in: 3600 })) as never;
      const kept = await refreshAccessToken('GOOGLE', 'rt');
      // Google omits it and the original stays valid. Null is the caller's
      // signal to leave the stored one alone — writing this through would
      // delete a working credential.
      expect(kept.refreshToken).toBeNull();

      global.fetch = jest.fn().mockResolvedValue(
        okJson({ access_token: 'new', expires_in: 3600, refresh_token: 'rotated' }),
      ) as never;
      expect(await refreshAccessToken('GOOGLE', 'rt')).toMatchObject({ refreshToken: 'rotated' });
    });

    it('expires a minute early, so a token cannot die mid-flight', async () => {
      process.env.GOOGLE_MAIL_CLIENT_ID = 'id';
      process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
      global.fetch = jest.fn().mockResolvedValue(okJson({ access_token: 'a', expires_in: 3600 })) as never;
      const before = Date.now();
      const r = (await refreshAccessToken('GOOGLE', 'rt')) as { expiresAt: number };
      // Strictly inside the hour the provider granted: the slack is what stops
      // a token expiring between the check and the send.
      expect(r.expiresAt).toBeLessThan(before + 3600 * 1000);
      expect(r.expiresAt).toBeGreaterThanOrEqual(before + 3540 * 1000);
    });
  });

  describe('needsRefresh', () => {
    it('treats an unrecorded expiry as expired', () => {
      // A token stored before this field existed has an unknown age; one wasted
      // refresh beats a send that fails on a customer.
      expect(needsRefresh({ oauthAccessToken: 'a' })).toBe(true);
    });

    it('is false only while the token is genuinely still good', () => {
      const now = 1_000_000;
      expect(needsRefresh({ oauthAccessToken: 'a', oauthExpiresAt: String(now + 1) }, now)).toBe(false);
      expect(needsRefresh({ oauthAccessToken: 'a', oauthExpiresAt: String(now) }, now)).toBe(true);
      expect(needsRefresh({ oauthExpiresAt: String(now + 10_000) }, now)).toBe(true);
    });
  });

  describe('exchangeCodeForTokens', () => {
    beforeEach(() => {
      process.env.GOOGLE_MAIL_CLIENT_ID = 'id';
      process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
    });

    it('refuses a grant with no refresh token instead of connecting an hour-long channel', async () => {
      // An access token alone connects a mailbox that works today and stops
      // tomorrow — a failure that surfaces days later, far from this code.
      global.fetch = jest.fn().mockResolvedValue(okJson({ access_token: 'a', expires_in: 3600 })) as never;
      const r = await exchangeCodeForTokens('GOOGLE', 'code', 'https://x/cb');
      expect(r).toMatchObject({ accessToken: null, error: expect.stringContaining('did not return a refresh token') });
    });

    it('sends the redirect_uri back, because the provider re-checks it', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        okJson({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      ) as never;
      const r = await exchangeCodeForTokens('GOOGLE', 'code', 'https://x/cb');
      expect(r).toMatchObject({ accessToken: 'a', refreshToken: 'r', error: null });
      const body = (global.fetch as jest.Mock).mock.calls[0][1].body as string;
      expect(new URLSearchParams(body).get('redirect_uri')).toBe('https://x/cb');
      expect(new URLSearchParams(body).get('grant_type')).toBe('authorization_code');
    });
  });

  describe('fetchConnectedAddress', () => {
    it('lower-cases, so the address matches the channel it should update', async () => {
      // Channel.externalId for EMAIL is stored lower-cased; a mixed-case answer
      // here would fail to find the existing channel and try to create a second
      // one for the same mailbox.
      global.fetch = jest.fn().mockResolvedValue(okJson({ email: 'Admin@Figurunica.com' })) as never;
      expect(await fetchConnectedAddress('GOOGLE', 't')).toBe('admin@figurunica.com');
    });

    it('falls back to the UPN, which is the address on an unlicensed Graph account', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        okJson({ mail: null, userPrincipalName: 'admin@figurunica.com' }),
      ) as never;
      expect(await fetchConnectedAddress('MICROSOFT', 't')).toBe('admin@figurunica.com');
    });

    it('answers null rather than a non-address', async () => {
      global.fetch = jest.fn().mockResolvedValue(okJson({ email: 'not-an-address' })) as never;
      expect(await fetchConnectedAddress('GOOGLE', 't')).toBeNull();
    });
  });
});
