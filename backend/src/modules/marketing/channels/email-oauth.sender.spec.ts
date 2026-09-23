import { Logger } from '@nestjs/common';
import {
  ACCESS_TOKEN_SLACK_SECONDS,
  DEFAULT_TOKEN_TTL_SECONDS,
  buildRfc822,
  exchangeCodeForTokens,
  fetchConnectedAddress,
  needsRefresh,
  refreshAccessToken,
  sendViaOAuth,
} from './email-oauth.sender';
import { HeaderInjectionError } from '../../../common/util/email-address';

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

    it('refuses a header value that carries a line break, rather than writing its headers', () => {
      // This builder joins strings, so a CR/LF in a recipient IS a header
      // writer — the one true injection site in the product. It refuses on its
      // own, independently of whatever the adapter checked first.
      const inject = (over: Record<string, string>) =>
        buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', ...over });
      expect(() => inject({ to: 'c@d.com\r\nBcc: victim@e.com' })).toThrow(HeaderInjectionError);
      expect(() => inject({ from: 'a@b.com\nReply-To: attacker@e.com' })).toThrow(HeaderInjectionError);
      expect(() => inject({ subject: 'hi\r\nX-Spoof: 1' })).toThrow(HeaderInjectionError);
      // The payload never reaches the log line the message ends up in.
      expect(() => inject({ to: 'c@d.com\r\nBcc: victim@e.com' })).toThrow(/^To contains a line break/);
    });

    it('wraps the base64 body, so no line is long enough for a relay to chop', () => {
      // A 2 KB line breaks the body hash of the sender's DKIM signature at the
      // first hop with a line limit, and the mail then fails DMARC.
      const text = 'Merhaba, teklifiniz hazır — ığüşöç çekirdek kampanyası. '.repeat(30);
      const raw = buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 's', text });
      for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
      const body = raw.split('\r\n\r\n')[1];
      for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
      expect(Buffer.from(body, 'base64').toString('utf8')).toBe(text);
    });

    it('folds a long Turkish subject on code points, not bytes', () => {
      // An encoded-word over 75 chars is refused by strict receivers, and a
      // fold taken mid-UTF-8-sequence corrupts exactly the Turkish letters the
      // encoding exists to carry.
      const subject = 'Ücretsiz çekirdek kampanyası — şubat ayına özel güncel fiyat listeniz ekte, iyi çalışmalar';
      const raw = buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject, text: 't' });
      const words = [...raw.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)];
      expect(words.length).toBeGreaterThan(1);
      for (const [word] of words) expect(word.length).toBeLessThanOrEqual(75);
      // RFC 2047 §5: adjacent encoded-words separated by folding whitespace are
      // concatenated on decode.
      expect(raw).toContain('?=\r\n =?UTF-8?B?');
      expect(words.map(([, b64]) => Buffer.from(b64, 'base64').toString('utf8')).join('')).toBe(subject);
    });

    it('builds a real multipart/alternative when there is HTML', () => {
      // This is what retires "a consent-connected mailbox is text-only"; the
      // plain part still goes first, because that is what alternative means.
      const raw = buildRfc822({
        from: 'a@b.com', to: 'c@d.com', subject: 's', text: 'merhaba', html: '<p>merhaba</p>',
      });
      const boundary = /boundary="([^"]+)"/.exec(raw)![1];
      expect(raw).toContain(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      const parts = raw.split(`--${boundary}`);
      expect(parts).toHaveLength(4); // headers, text, html, closing
      expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
      expect(parts[2]).toContain('Content-Type: text/html; charset="UTF-8"');
      expect(parts[3]).toBe('--\r\n');
      const decode = (part: string) => Buffer.from(part.split('\r\n\r\n')[1], 'base64').toString('utf8');
      expect(decode(parts[1])).toBe('merhaba');
      expect(decode(parts[2])).toBe('<p>merhaba</p>');
    });

    it('stays single-part when there is no HTML', () => {
      const raw = buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 'merhaba' });
      expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
      expect(raw).not.toContain('multipart/alternative');
    });

    it('puts the angle brackets on the threading headers itself, exactly once', () => {
      // Half the callers hold a bare id and half hold a bracketed one; a header
      // written either way threads nowhere.
      const raw = buildRfc822({
        from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't',
        inReplyTo: 'abc@Mail.Google.com',
        references: ['<one@x.com>', 'two@y.com'],
      });
      expect(raw).toContain('In-Reply-To: <abc@mail.google.com>');
      expect(raw).toContain('References: <one@x.com> <two@y.com>');
    });

    it('omits a threading header rather than emitting an empty one', () => {
      const raw = buildRfc822({
        from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', inReplyTo: '', references: ['', '   '],
      });
      expect(raw).not.toContain('In-Reply-To:');
      expect(raw).not.toContain('References:');
    });

    it('mime-word encodes a display name instead of pasting it into the From', () => {
      // `"Güneş Çiçek" <a@b.com>` is 8-bit in a header specified as ASCII, and
      // a name carrying a quote would break the quoting outright. Both are the
      // reason nodemailer is handed an object on the SMTP side.
      const raw = buildRfc822({
        from: 'a@b.com', fromName: 'Güneş "Kahve" Çiçek', to: 'c@d.com', subject: 's', text: 't',
      });
      expect(raw).toContain('From: =?UTF-8?B?');
      expect(raw).toContain('<a@b.com>');
      expect(raw).not.toContain('Güneş');
      const b64 = /From: =\?UTF-8\?B\?(.+?)\?=/.exec(raw)![1];
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Güneş "Kahve" Çiçek');
    });

    it('leaves the From bare when there is no display name', () => {
      const raw = buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't' });
      expect(raw).toContain('From: a@b.com\r\n');
    });

    it('carries Reply-To, so an answer reaches the tenant and not the mailbox owner', () => {
      const raw = buildRfc822({
        from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', replyTo: 'sales@tenant.test',
      });
      expect(raw).toContain('Reply-To: sales@tenant.test');
    });

    it("writes the gateway's Message-ID with brackets, exactly once", () => {
      // DSN attribution and Sent-folder dedupe match on this id, so the one the
      // gateway stored has to be the one on the wire.
      const raw = buildRfc822({
        from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', messageId: 'ml-1.abc@jeetagrowth.com',
      });
      expect(raw).toContain('Message-ID: <ml-1.abc@jeetagrowth.com>');
      expect(raw.match(/Message-ID:/g)).toHaveLength(1);
    });

    it('marks an auto-generated mail as one, so it cannot start a bounce loop', () => {
      const raw = buildRfc822({
        from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', autoSubmitted: 'auto-replied',
      });
      expect(raw).toContain('Auto-Submitted: auto-replied');
    });

    it('carries a calendar invite as its own part, with the threaded METHOD', () => {
      // A consent-connected mailbox is the one transport that builds its own
      // MIME, so an invite has to be assembled here or it is silently dropped.
      const raw = buildRfc822({
        from: 'a@b.com',
        to: 'c@d.com',
        subject: 's',
        text: 'Randevunuz iptal edildi',
        ics: { method: 'CANCEL', content: 'BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR' },
      });
      expect(raw).toContain('multipart/mixed');
      expect(raw).toContain('Content-Type: text/calendar; charset="UTF-8"; method=CANCEL');
      expect(raw).toContain('Content-Disposition: attachment; filename="invite.ics"');
      const part = /Content-Type: text\/calendar[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)![1];
      expect(Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8')).toContain('METHOD:CANCEL');
    });

    it('still carries the html alternative beside an invite', () => {
      const raw = buildRfc822({
        from: 'a@b.com',
        to: 'c@d.com',
        subject: 's',
        text: 'plain',
        html: '<p>rich</p>',
        ics: { method: 'REQUEST', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', filename: 'randevu.ics' },
      });
      expect(raw).toContain('multipart/mixed');
      expect(raw).toContain('multipart/alternative');
      expect(raw).toContain('method=REQUEST');
      expect(raw).toContain('filename="randevu.ics"');
    });

    it('refuses a poisoned display name or Reply-To as well as the address', () => {
      expect(() =>
        buildRfc822({ from: 'a@b.com', fromName: 'x\r\nBcc: victim@e.com', to: 'c@d.com', subject: 's', text: 't' }),
      ).toThrow(HeaderInjectionError);
      expect(() =>
        buildRfc822({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't', replyTo: 'x\r\nBcc: v@e.com' }),
      ).toThrow(HeaderInjectionError);
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

    it('answers a refusal instead of throwing when a header value is poisoned', async () => {
      // G2: nothing new throws out of a transport. The refusal is a result, and
      // the request is never made.
      const fetchMock = jest.fn();
      global.fetch = fetchMock as never;
      const r = await sendViaOAuth({
        provider: 'GOOGLE', accessToken: 't', from: 'a@b.com',
        to: 'c@d.com\r\nBcc: victim@e.com', subject: 's', text: 't',
      });
      expect(r).toMatchObject({ ok: false, externalId: null, error: expect.stringContaining('line break') });
      expect(fetchMock).not.toHaveBeenCalled();
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
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      // The JSON shape is the one proven against Graph; a text-only mail keeps it.
      expect(JSON.parse(init.body).message.body).toEqual({ contentType: 'Text', content: 'body' });
    });

    it('names the sender and the Reply-To on the JSON shape too', async () => {
      // Graph builds the From itself, so the name and the Reply-To have to be
      // given as fields — there is no header to write them into.
      global.fetch = jest.fn().mockResolvedValue(okJson({}, 202)) as never;
      await sendViaOAuth({
        provider: 'MICROSOFT', accessToken: 't', from: 'a@b.com', fromName: 'Tenant Co',
        replyTo: 'sales@tenant.test', to: 'c@d.com', subject: 's', text: 'body',
      });
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      const message = JSON.parse(init.body).message;
      expect(message.from).toEqual({ emailAddress: { address: 'a@b.com', name: 'Tenant Co' } });
      expect(message.replyTo).toEqual([{ emailAddress: { address: 'sales@tenant.test' } }]);
    });

    it('switches to MIME for a header the JSON shape cannot carry', async () => {
      // Graph's `internetMessageHeaders` takes `x-`-prefixed names only, so a
      // Message-ID, Auto-Submitted or a threading header is only reachable as MIME.
      global.fetch = jest.fn().mockResolvedValue(okJson({}, 202)) as never;
      await sendViaOAuth({
        provider: 'MICROSOFT', accessToken: 't', from: 'a@b.com', to: 'c@d.com',
        subject: 's', text: 'body', messageId: 'ml-1@jeetagrowth.com', autoSubmitted: 'auto-generated',
        inReplyTo: 'prev@x.com',
      });
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
      const mime = Buffer.from(init.body as string, 'base64').toString('utf8');
      expect(mime).toContain('Message-ID: <ml-1@jeetagrowth.com>');
      expect(mime).toContain('Auto-Submitted: auto-generated');
      expect(mime).toContain('In-Reply-To: <prev@x.com>');
    });

    it('switches to MIME when there is HTML, because the JSON body carries only one part', async () => {
      global.fetch = jest.fn().mockResolvedValue(okJson({}, 202)) as never;
      const r = await sendViaOAuth({
        provider: 'MICROSOFT', accessToken: 't', from: 'a@b.com', to: 'c@d.com',
        subject: 's', text: 'merhaba', html: '<p>merhaba</p>',
      });
      expect(r).toMatchObject({ ok: true, externalId: null });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
      const mime = Buffer.from(init.body as string, 'base64').toString('utf8');
      expect(mime).toContain('Content-Type: multipart/alternative;');
      expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    });

    it('answers a refusal instead of throwing when a header value is poisoned', async () => {
      // Checked before the shape is chosen: the JSON branch builds no MIME, so
      // it would otherwise hand the poisoned value straight to Graph.
      const fetchMock = jest.fn();
      global.fetch = fetchMock as never;
      const r = await sendViaOAuth({
        provider: 'MICROSOFT', accessToken: 't', from: 'a@b.com',
        to: 'c@d.com\r\nBcc: victim@e.com', subject: 's', text: 't',
      });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('line break') });
      expect(fetchMock).not.toHaveBeenCalled();
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

    it('publishes the TTL it assumes, so the refresh sweep can be timed against it', () => {
      // The sweep has to revisit a token BEFORE it dies; that is an arithmetic
      // claim about these two numbers, and it is only checkable if they are
      // one value rather than two copies.
      expect(DEFAULT_TOKEN_TTL_SECONDS).toBe(3600);
      expect(ACCESS_TOKEN_SLACK_SECONDS).toBe(60);
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

    it('says WHY the provider refused, instead of swallowing it', async () => {
      // Microsoft's /me refuses without the `User.Read` scope. The caller maps
      // every cause to the same `?connect_error=1` page, so if this does not
      // reach a log an operator has a broken connect and nothing to act on.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Insufficient privileges to complete the operation.',
      }) as never;

      expect(await fetchConnectedAddress('MICROSOFT', 't')).toBeNull();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Insufficient privileges'));
      warn.mockRestore();
    });

    it('says so when the lookup never completed at all', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted')) as never;

      expect(await fetchConnectedAddress('GOOGLE', 't')).toBeNull();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('aborted'));
      warn.mockRestore();
    });
  });
});
