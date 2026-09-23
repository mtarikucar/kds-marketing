// nodemailer mock — capture sendMail / verify calls without a real SMTP server.
// The options are captured too: `forceAuth` is the difference between "this
// mailbox accepted our password" and "some open relay said hello".
const sendMail = jest.fn();
const verify = jest.fn();
const close = jest.fn();
const createTransport = jest.fn((_opts?: any) => ({ sendMail, verify, close }));
jest.mock('nodemailer', () => ({ createTransport: (opts: any) => createTransport(opts) }));

// imapflow mock — the RECEIVE half of the probe, without a mail server.
const mockImap = {
  opts: null as any,
  built: 0,
  connect: jest.fn(async () => undefined),
  mailboxOpen: jest.fn(async () => ({ exists: 0 })),
  logout: jest.fn(async () => undefined),
};
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts: any) => {
    mockImap.opts = opts;
    mockImap.built++;
    return {
      connect: mockImap.connect,
      mailboxOpen: mockImap.mailboxOpen,
      logout: mockImap.logout,
    };
  }),
}));

import { EmailChannelAdapter } from './email.adapter';

const SMTP = {
  smtpHost: 'smtp.acme.test',
  smtpPort: '587',
  smtpUser: 'bot@acme.test',
  smtpPass: 'secret',
  fromEmail: 'bot@acme.test',
};

/** The same mailbox with an incoming server the operator typed in. */
const SMTP_WITH_IMAP = { ...SMTP, imapHost: 'imap.acme.test', imapPort: '993' };

describe('EmailChannelAdapter', () => {
  const registry = { register: jest.fn() } as any;
  const oauthRefresh = { refreshNow: jest.fn() } as any;
  let adapter: EmailChannelAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockImap.built = 0;
    mockImap.opts = null;
    mockImap.connect.mockResolvedValue(undefined);
    mockImap.mailboxOpen.mockResolvedValue({ exists: 0 } as any);
    mockImap.logout.mockResolvedValue(undefined);
    adapter = new EmailChannelAdapter(registry, oauthRefresh);
  });

  it('registers itself on module init as EMAIL', () => {
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);
    expect(adapter.type).toBe('EMAIL');
  });

  it('send is inert (FAILED, no throw, no SMTP) without credentials', async () => {
    const res = await adapter.send({ config: { secrets: {} } as any, to: 'lead@x.test', text: 'hi' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SMTP');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('send delivers via the workspace SMTP and returns the provider message id', async () => {
    sendMail.mockResolvedValue({ messageId: '<abc@acme.test>' });
    const res = await adapter.send({
      config: { secrets: SMTP, public: { subject: 'Re: hello' } } as any,
      to: 'lead@x.test',
      text: 'thanks!',
    });
    expect(res.status).toBe('SENT');
    expect(res.externalMessageId).toBe('<abc@acme.test>');
    const mail = sendMail.mock.calls[0][0];
    expect(mail).toMatchObject({ from: 'bot@acme.test', to: 'lead@x.test', subject: 'Re: hello', text: 'thanks!' });
  });

  describe('one recipient, always', () => {
    it('refuses a comma-separated list instead of mailing two people on one token', async () => {
      // One `to`, one unsubscribe token, one trace row. A list here sends the
      // second person a link that speaks for the first.
      const res = await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'info@x.test, satis@x.test',
        text: 'hi',
        subject: 'S',
      });
      expect(res.status).toBe('FAILED');
      expect(res.error).toMatch(/one email address/i);
      expect(createTransport).not.toHaveBeenCalled();
    });

    it('refuses a recipient carrying a header break', async () => {
      const res = await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'lead@x.test\r\nBcc: victim@x.test',
        text: 'hi',
        subject: 'S',
      });
      expect(res.status).toBe('FAILED');
      expect(res.retriable).toBe(false);
      expect(createTransport).not.toHaveBeenCalled();
    });

    it('refuses the display-name form, which nodemailer would expand', async () => {
      const res = await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'Lead <lead@x.test>',
        text: 'hi',
        subject: 'S',
      });
      expect(res.status).toBe('FAILED');
      expect(createTransport).not.toHaveBeenCalled();
    });
  });

  it('send prefers a per-call subject over the thread default', async () => {
    // This adapter was written for inbound replies, where the subject belongs
    // to the thread and sits on the channel config. A campaign has a different
    // subject per send; without this the whole campaign went out as
    // "Re: your message".
    sendMail.mockResolvedValue({ messageId: '<x@acme.test>' });
    await adapter.send({
      config: { secrets: SMTP, public: { subject: 'Re: hello' } } as any,
      to: 'lead@x.test',
      text: 'body',
      subject: 'Kâğıt adisyon yerine mutfak ekranı',
    });
    expect(sendMail.mock.calls[0][0].subject).toBe('Kâğıt adisyon yerine mutfak ekranı');
  });

  it('never invents a "Re:" on a first-contact mail', async () => {
    // A Turkish prospect who has never written to us received an English fake
    // reply, and every later message in the thread kept it (`fake-re-subject`).
    sendMail.mockResolvedValue({ messageId: '<x@acme.test>' });
    await adapter.send({ config: { secrets: SMTP, public: {} } as any, to: 'lead@x.test', text: 'body' });
    const subject = String(sendMail.mock.calls[0][0].subject);
    expect(subject).not.toMatch(/^re:/i);
    expect(subject.trim()).not.toBe('');
  });

  it('send carries an HTML body ALONGSIDE the text one', async () => {
    // Multipart, never HTML-only: that is what clients and spam filters expect,
    // and an HTML-only mail from a new sending identity is a reputation problem
    // by itself.
    sendMail.mockResolvedValue({ messageId: '<y@acme.test>' });
    await adapter.send({
      config: { secrets: SMTP, public: {} } as any,
      to: 'lead@x.test',
      text: 'plain',
      subject: 'S',
      html: '<p>rich</p>',
    });
    expect(sendMail.mock.calls[0][0]).toMatchObject({ text: 'plain', html: '<p>rich</p>' });
  });

  it('send omits html entirely when none is given', async () => {
    sendMail.mockResolvedValue({ messageId: '<z@acme.test>' });
    await adapter.send({
      config: { secrets: SMTP, public: {} } as any,
      to: 'lead@x.test',
      text: 'plain',
    });
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('html');
  });

  it('send returns FAILED (not throw) on an SMTP error', async () => {
    sendMail.mockRejectedValue(new Error('535 auth failed'));
    const res = await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'hi' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('535');
  });

  describe('the identity on the envelope', () => {
    it('sends with a display name when the caller supplies one', async () => {
      // nodemailer's object form, never a hand-built `"Name" <a@b>` string: a
      // workspace called `Şen "Pide" A.Ş.` produces a malformed header that way.
      sendMail.mockResolvedValue({ messageId: '<n@acme.test>' });
      await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'lead@x.test',
        text: 'body',
        subject: 'S',
        fromName: 'Şen "Pide" A.Ş.',
      });
      expect(sendMail.mock.calls[0][0].from).toEqual({
        name: 'Şen "Pide" A.Ş.',
        address: 'bot@acme.test',
      });
    });

    it('falls back to the name stored on the channel', async () => {
      sendMail.mockResolvedValue({ messageId: '<n2@acme.test>' });
      await adapter.send({
        config: { secrets: SMTP, public: { fromName: 'Acme Kitchen' } } as any,
        to: 'lead@x.test',
        text: 'body',
        subject: 'S',
      });
      expect(sendMail.mock.calls[0][0].from).toEqual({ name: 'Acme Kitchen', address: 'bot@acme.test' });
    });

    it('carries a Reply-To when the caller supplies one', async () => {
      sendMail.mockResolvedValue({ messageId: '<n3@acme.test>' });
      await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'lead@x.test',
        text: 'body',
        subject: 'S',
        replyTo: 'satis@acme.test',
      });
      expect(sendMail.mock.calls[0][0].replyTo).toBe('satis@acme.test');
    });

    it('sends no Reply-To at all when none is given', async () => {
      sendMail.mockResolvedValue({ messageId: '<n4@acme.test>' });
      await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'body', subject: 'S' });
      expect(sendMail.mock.calls[0][0]).not.toHaveProperty('replyTo');
    });
  });

  describe('threading', () => {
    it('puts In-Reply-To/References at the top level, beside the unsubscribe pair', async () => {
      // Inside `headers` they would overwrite (or be overwritten by) the
      // List-Unsubscribe pair, which is built as a whole object.
      sendMail.mockResolvedValue({ messageId: '<t@acme.test>' });
      await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'lead@x.test',
        text: 'body',
        subject: 'S',
        inReplyTo: '<prev@buyer.test>',
        references: ['<first@buyer.test>', '<prev@buyer.test>'],
        autoSubmitted: 'auto-replied',
        listUnsubscribeUrl: 'https://m.test/api/public/u/tok-1',
      });
      const mail = sendMail.mock.calls[0][0];
      expect(mail.inReplyTo).toBe('<prev@buyer.test>');
      expect(mail.references).toEqual(['<first@buyer.test>', '<prev@buyer.test>']);
      expect(mail.headers).toEqual({
        'List-Unsubscribe': '<https://m.test/api/public/u/tok-1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Auto-Submitted': 'auto-replied',
      });
    });

    it('sends the Message-ID the ledger already recorded', async () => {
      sendMail.mockResolvedValue({ messageId: '<mail-1@jeetagrowth.com>' });
      await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'lead@x.test',
        text: 'body',
        subject: 'S',
        messageId: '<mail-1@jeetagrowth.com>',
      });
      expect(sendMail.mock.calls[0][0].messageId).toBe('<mail-1@jeetagrowth.com>');
    });
  });

  describe('what the caller is told about a failure', () => {
    it('marks a 4xx as worth retrying', async () => {
      sendMail.mockRejectedValue(
        Object.assign(new Error('450 4.2.1 mailbox busy'), { responseCode: 450 }),
      );
      const res = await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'hi' });
      expect(res).toMatchObject({ status: 'FAILED', retriable: true, smtpCode: 450 });
    });

    it('marks a dead mailbox as terminal and names the enhanced code', async () => {
      sendMail.mockRejectedValue(
        Object.assign(new Error('550 5.1.1 User unknown'), { responseCode: 550 }),
      );
      const res = await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'hi' });
      expect(res).toMatchObject({ status: 'FAILED', retriable: false, smtpCode: 550, smtpEnhanced: '5.1.1' });
    });
  });

  describe('healthCheck', () => {
    const OAUTH = {
      oauthProvider: 'GOOGLE',
      oauthAccessToken: 'tok',
      oauthRefreshToken: 'ref',
      oauthExpiresAt: String(Date.now() + 3_600_000),
      fromEmail: 'bot@acme.test',
    };

    it('authenticates the probe connection instead of trusting the server', async () => {
      // A host that never offers AUTH used to pass Verify, and `lastVerifiedAt`
      // is what four other paths read as "this workspace owns this mailbox"
      // (`mailbox-any-host-verify`).
      verify.mockResolvedValue(true);
      await adapter.healthCheck({ secrets: SMTP } as any);
      expect(createTransport.mock.calls[0][0]).toMatchObject({ forceAuth: true });
    });

    it('authenticates the SEND connection too', async () => {
      // healthCheck alone is useless: message-sender and outbound-conversation
      // both send without ever consulting lastVerifiedAt.
      sendMail.mockResolvedValue({ messageId: '<f@acme.test>' });
      await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'hi', subject: 'S' });
      expect(createTransport.mock.calls[0][0]).toMatchObject({ forceAuth: true });
    });

    it('verifies the SMTP login and says the mailbox cannot RECEIVE without an IMAP host', async () => {
      // `smtp.acme.test` is not in the autodiscover table, so there is no
      // incoming server to try. Claiming receive:true here is what left a cPanel
      // SMB looking at "Channel verified ✓" while no reply was ever ingested.
      verify.mockResolvedValue(true);
      const res = await adapter.healthCheck({ secrets: SMTP } as any);
      expect(res.ok).toBe(true);
      expect(res.details).toMatchObject({ transport: 'smtp', send: true, receive: false });
      expect(String(res.details?.receiveReason)).toMatch(/IMAP/i);
    });

    it('answers with a machine CODE, and keeps the prose beside it', async () => {
      // `channels.verifySendOnly` interpolates this straight into an otherwise
      // Turkish sentence, so an English sentence here reaches the tenant
      // verbatim (PLAN G8). The code is what the UI translates; the prose stays
      // for the operator reading a log or a health blob.
      verify.mockResolvedValue(true);
      const res = await adapter.healthCheck({ secrets: SMTP } as any);
      expect(res.details?.receiveReason).toBe('NO_IMAP_HOST');
      expect(String(res.details?.receiveDetail)).toMatch(/IMAP host/i);
    });

    it('distinguishes a consent mailbox with no incoming password from a missing host', async () => {
      // The two need different fixes — reconnect with an app password, versus
      // fill in an IMAP host — so one code cannot serve both.
      const res = await adapter.healthCheck({ secrets: OAUTH } as any);
      expect(res.details?.receiveReason).toBe('OAUTH_NO_IMAP_PASSWORD');
    });

    it('codes a refused IMAP login and carries the server’s own words as detail', async () => {
      verify.mockResolvedValue(true);
      mockImap.connect.mockRejectedValue(new Error('AUTHENTICATIONFAILED'));
      const res = await adapter.healthCheck({ secrets: SMTP_WITH_IMAP } as any);
      expect(res.details?.receiveReason).toBe('IMAP_REFUSED');
      expect(String(res.details?.receiveDetail)).toContain('AUTHENTICATIONFAILED');
    });

    it('does NOT guess the IMAP host from the SMTP host', async () => {
      // A blanket default would start logins against hosts nobody proved —
      // including pure relays that have no IMAP at all.
      verify.mockResolvedValue(true);
      await adapter.healthCheck({ secrets: SMTP } as any);
      expect(mockImap.built).toBe(0);
    });

    it('reports receive:true once the IMAP login actually works', async () => {
      verify.mockResolvedValue(true);
      const res = await adapter.healthCheck({ secrets: SMTP_WITH_IMAP } as any);
      expect(res.ok).toBe(true);
      expect(res.details).toMatchObject({ send: true, receive: true });
      expect(mockImap.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });
      expect(mockImap.opts).toMatchObject({ host: 'imap.acme.test', port: 993, secure: true });
      expect(mockImap.logout).toHaveBeenCalled();
    });

    it('keeps ok TRUE when only the IMAP login fails, and says why', async () => {
      // `ok` is SEND-truth. channels.service stamps lastVerifiedAt on it, and
      // that column is what routes a tenant's mail through their own address —
      // flipping it would silently reroute every tenant mail to the platform.
      verify.mockResolvedValue(true);
      mockImap.connect.mockRejectedValue(new Error('AUTHENTICATIONFAILED'));
      const res = await adapter.healthCheck({ secrets: SMTP_WITH_IMAP } as any);
      expect(res.ok).toBe(true);
      expect(res.details).toMatchObject({ send: true, receive: false });
      expect(String(res.details?.receiveReason)).toMatch(/IMAP/i);
      // Even a failed probe hangs a socket open until it is told not to.
      expect(mockImap.logout).toHaveBeenCalled();
    });

    it('passes a consent-connected mailbox WITHOUT asking it for SMTP credentials', async () => {
      // EmailOAuthService.handleCallback clears the SMTP keys on purpose, so
      // judging this mailbox by smtp() answered "SMTP credentials missing" — a
      // false failure on a mailbox that sends perfectly well over HTTP, and the
      // one thing the operator sees when they press Verify.
      const res = await adapter.healthCheck({ secrets: OAUTH } as any);
      expect(res.ok).toBe(true);
      expect(createTransport).not.toHaveBeenCalled();
      expect(res.details).toMatchObject({ transport: 'oauth', provider: 'GOOGLE', send: true });
    });

    it('says plainly that a consent-connected mailbox cannot RECEIVE', async () => {
      // There is no XOAUTH2 IMAP path anywhere, so consent ALONE buys sending
      // only. The connect dialog promises two-way email; this is what keeps
      // that promise honest instead of silently half-true.
      const res = await adapter.healthCheck({ secrets: OAUTH } as any);
      expect(res.details).toMatchObject({ receive: false });
      // It names what is missing — an incoming password — rather than implying
      // an ESP the tenant has not got.
      expect(String(res.details?.receiveReason)).toMatch(/IMAP/i);
    });

    it('does NOT claim send-only for a consent mailbox that holds an IMAP password', async () => {
      // Gmail readonly needs CASA, so "wait for the read scope" means "no
      // replies, indefinitely". Consent for send plus an app password for
      // receive works today — and once the pollers use it, a card still
      // saying "send-only" contradicts the mail arriving in the inbox.
      const res = await adapter.healthCheck({
        secrets: {
          ...OAUTH,
          imapHost: 'imap.gmail.com',
          imapPort: '993',
          imapUser: 'owner@gmail.com',
          imapPass: 'app-password',
        },
      } as any);
      // The probe was attempted rather than short-circuited, and it reports
      // what the mailbox actually answered.
      expect(res.details).toMatchObject({ receive: true, imapHost: 'imap.gmail.com' });
      expect(res.details?.receiveReason).toBeUndefined();
      // `ok` is SEND-truth and must stay that way: channels.service stamps
      // `lastVerifiedAt` on it alone, and that column reroutes every tenant's
      // mail back to the platform address when it is null.
      expect(res.ok).toBe(true);
    });

    it('mirrors send(): an expired token the provider will not renew is not healthy', async () => {
      // healthCheck asks for a fresh token exactly as send() does (see the
      // consent-transport block below) and reports the provider's refusal when
      // there is one. What it must never do is paper over the failure.
      oauthRefresh.refreshNow.mockResolvedValue({
        accessToken: null,
        expiresAt: null,
        error: 'invalid_grant: Token has been expired or revoked.',
      });
      const res = await adapter.healthCheck({
        channelId: 'ch-1',
        workspaceId: 'ws-1',
        secrets: { ...OAUTH, oauthExpiresAt: String(Date.now() - 1_000) },
      } as any);
      expect(res.ok).toBe(false);
      expect(String(res.details?.reason)).toContain('invalid_grant');
    });

    it('still refuses a channel with neither consent nor SMTP credentials', async () => {
      const res = await adapter.healthCheck({ secrets: {} } as any);
      expect(res.ok).toBe(false);
      expect(createTransport).not.toHaveBeenCalled();
    });

    it('does not probe IMAP when the SMTP login itself failed', async () => {
      verify.mockRejectedValue(new Error('535 Invalid login'));
      const res = await adapter.healthCheck({ secrets: SMTP_WITH_IMAP } as any);
      expect(res.ok).toBe(false);
      expect(res.details).toMatchObject({ send: false, receive: false });
      expect(mockImap.built).toBe(0);
    });
  });

  describe('List-Unsubscribe — bulk sends only', () => {
    it('turns listUnsubscribeUrl into the RFC 8058 header pair', async () => {
      sendMail.mockResolvedValue({ messageId: '<a@acme.test>' });
      await adapter.send({
        config: { secrets: SMTP } as any,
        to: 'lead@x.test',
        text: 'body',
        subject: 'S',
        listUnsubscribeUrl: 'https://m.test/api/public/u/tok-1',
      });
      expect(sendMail.mock.calls[0][0].headers).toEqual({
        'List-Unsubscribe': '<https://m.test/api/public/u/tok-1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('sends NO such header on an ordinary one-to-one reply', async () => {
      // This adapter's day job is answering one person from the inbox. Marking
      // that as list mail would be a lie to the client AND to the filters.
      sendMail.mockResolvedValue({ messageId: '<b@acme.test>' });
      await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'body', subject: 'S' });
      expect(sendMail.mock.calls[0][0]).not.toHaveProperty('headers');
    });
  });

  it('parseInbound normalizes a Mailgun-style payload and tags it EMAIL', () => {
    const out = adapter.parseInbound({ secrets: SMTP, externalId: 'support@acme.test' } as any, {
      sender: 'Jane Doe <jane@buyer.test>',
      recipient: 'support@acme.test',
      subject: 'Question',
      'stripped-text': 'Do you ship to TR?',
      'message-id': '<m-1@buyer.test>',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalUserId: 'jane@buyer.test',
      kind: 'EMAIL',
      externalMessageId: '<m-1@buyer.test>',
      displayName: 'Jane Doe',
    });
    expect(out[0].text).toContain('Question');
    expect(out[0].text).toContain('Do you ship to TR?');
  });

  it('parseInbound attributes a spoofed display name to the REAL sender', () => {
    // The old first-`<>` regex read the address out of the display name, so
    // `"<ceo@victim>" <attacker@evil>` filed the mail under the CEO — and the
    // same regex picks the tenant on the inbound webhook.
    const out = adapter.parseInbound({ secrets: SMTP } as any, {
      from: '"<ceo@victim.test>" <attacker@evil.test>',
      text: 'wire me the money',
    });
    expect(out[0]).toMatchObject({
      externalUserId: 'attacker@evil.test',
      displayName: '<ceo@victim.test>',
    });
  });

  it('parseInbound supports a Postmark-style payload', () => {
    const out = adapter.parseInbound({ secrets: SMTP } as any, {
      From: 'buyer@x.test',
      Subject: 'Hi',
      TextBody: 'hello there',
      MessageID: 'pm-1',
    });
    expect(out[0]).toMatchObject({ externalUserId: 'buyer@x.test', externalMessageId: 'pm-1' });
  });

  it('parseInbound drops our own address (echo / auto-reply loop guard)', () => {
    const out = adapter.parseInbound({ secrets: SMTP, externalId: 'support@acme.test' } as any, {
      from: 'bot@acme.test',
      text: 'auto-reply echo',
    });
    expect(out).toHaveLength(0);
  });

  it('parseInbound drops an echo that matches smtpUser even when fromEmail is unset', () => {
    // send() From = fromEmail || smtpUser, so smtpUser alone must still guard.
    const out = adapter.parseInbound({ secrets: { smtpUser: 'Bot@Acme.test' } } as any, {
      from: 'bot@acme.test',
      text: 'echo',
    });
    expect(out).toHaveLength(0);
  });

  it('parseInbound ignores empty/whitespace bodies', () => {
    const out = adapter.parseInbound({ secrets: SMTP } as any, { from: 'a@b.test', text: '   ' });
    expect(out).toHaveLength(0);
  });

  describe('parseInbound — who the mail is really from', () => {
    it('follows a CROSS-DOMAIN Reply-To to the enquirer, with THEIR name', () => {
      // A contact-form relay mails as the website and puts the submitter in
      // Reply-To. Reading only the From files every enquiry on one fake lead
      // named after the site — and the name sticks, because the AI's capture
      // path fills only EMPTY fields.
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'WordPress <wordpress@site.test>',
        'reply-to': 'Ayşe Yılmaz <ayse@musteri.test>',
        text: 'Fiyat listesi alabilir miyim?',
      });
      expect(out[0]).toMatchObject({
        externalUserId: 'ayse@musteri.test',
        displayName: 'Ayşe Yılmaz',
      });
    });

    it('leaves a SAME-domain Reply-To alone', () => {
      // A vendor newsletter points noreply@vendor at sales@vendor. Following
      // that would turn every vendor blast into a lead for their sales desk.
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'noreply@vendor.test',
        replyTo: 'sales@vendor.test',
        text: 'Our new catalogue is out',
      });
      expect(out[0].externalUserId).toBe('noreply@vendor.test');
    });

    it('rescues a form that mails FROM the mailbox itself', () => {
      // The override runs BEFORE the own-address check, or a form relaying
      // through the tenant's own address is dropped as an echo.
      const out = adapter.parseInbound(
        { secrets: SMTP, externalId: 'support@acme.test' } as any,
        {
          from: 'support@acme.test',
          'reply-to': 'Can <can@musteri.test>',
          text: 'Web sitesinden mesaj',
        },
      );
      expect(out[0]).toMatchObject({ externalUserId: 'can@musteri.test', displayName: 'Can' });
    });

    it('still drops the echo when Reply-To points back at us', () => {
      // The own-address check RE-RUNS on the resolved address, or a form that
      // left Reply-To on our own mailbox opens a self-reply loop.
      const out = adapter.parseInbound(
        { secrets: SMTP, externalId: 'support@acme.test' } as any,
        { from: 'relay@site.test', 'reply-to': 'support@acme.test', text: 'loop' },
      );
      expect(out).toHaveLength(0);
    });
  });

  describe('parseInbound — what the transport could prove', () => {
    it('marks an explicit authentication failure unverified', () => {
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'ceo@victim.test',
        text: 'wire the money to this new account',
        authVerdict: 'fail',
      });
      // Still ingested and still attached to the lead — only the automation
      // downstream is held. Silence is the failure mode being removed.
      expect(out).toHaveLength(1);
      expect(out[0].senderVerified).toBe(false);
    });

    it('leaves senderVerified UNSET when nothing authenticated the mail', () => {
      // Three states, and this is the one almost all mail is in. Collapsing it
      // to false would make unverifiable mail read as forged.
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'jane@buyer.test',
        text: 'hello',
        authVerdict: 'unknown',
      });
      expect(out[0].senderVerified).toBeUndefined();
      expect('senderVerified' in out[0]).toBe(false);
    });

    it('reads the webhook path\'s nested verdict too', () => {
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'jane@buyer.test',
        text: 'hello',
        auth: { verdict: 'pass', spf: 'pass', dkim: 'pass' },
      });
      expect(out[0].senderVerified).toBe(true);
    });
  });

  describe('parseInbound — quoting', () => {
    const QUOTED = [
      'Evet, uygundur.',
      '',
      'On Mon, 1 Sep 2026 at 10:00, Acme <support@acme.test> wrote:',
      '> Teklifimiz ektedir.',
      '> Saygılarımızla',
    ].join('\n');

    it('strips the quoted thread off a raw provider body', () => {
      // The legacy route posts whatever the provider sent. Without this the
      // AI reads — and answers — our own quoted message.
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'jane@buyer.test',
        text: QUOTED,
      });
      expect(out[0].text).toContain('Evet, uygundur.');
      expect(out[0].text).not.toContain('Teklifimiz ektedir.');
    });

    it('does not strip a body the caller already stripped', () => {
      // Both internal doors strip before they get here. A second pass on a
      // reply that is now a few words is how a short answer becomes empty.
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'jane@buyer.test',
        text: 'On this we agree, so wrote it up',
        textIsStripped: true,
      });
      expect(out[0].text).toBe('On this we agree, so wrote it up');
    });

    it('does not strip a provider-stripped body', () => {
      const out = adapter.parseInbound({ secrets: SMTP } as any, {
        from: 'jane@buyer.test',
        'stripped-text': 'On this we agree',
        text: QUOTED,
      });
      expect(out[0].text).toBe('On this we agree');
    });
  });

  describe('consent-connected mailbox (OAuth transport)', () => {
    const realFetch = global.fetch;
    const OAUTH = {
      oauthProvider: 'GOOGLE',
      oauthAccessToken: 'tok',
      oauthRefreshToken: 'ref',
      oauthExpiresAt: String(Date.now() + 3_600_000),
      fromEmail: 'bot@acme.test',
    };
    const DEAD = { ...OAUTH, oauthExpiresAt: String(Date.now() - 1_000) };
    const cfg = (secrets: Record<string, string>, pub: Record<string, unknown> = {}) =>
      ({ channelId: 'ch-1', workspaceId: 'ws-1', secrets, public: pub }) as any;

    /** What actually went to Gmail, decoded back out of base64url. */
    const wire = () => {
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      const raw = JSON.parse(init.body as string).raw as string;
      return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    };

    beforeEach(() => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1' }) }) as never;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    it('forwards the HTML part, the display name and the Reply-To', async () => {
      // The OAuth branch used to forward {from,to,subject,text} and nothing
      // else, so a consent-connected mailbox sent bare-From and text-only while
      // an SMTP one carried both (`no-display-name`).
      const res = await adapter.send({
        config: cfg(OAUTH, { fromName: 'Tenant Co' }),
        to: 'lead@x.test',
        subject: 'Teklifiniz',
        text: 'merhaba',
        html: '<p>merhaba</p>',
        replyTo: 'sales@tenant.test',
      });
      expect(res).toMatchObject({ status: 'SENT', externalMessageId: 'g-1' });
      const raw = wire();
      expect(raw).toContain('Content-Type: multipart/alternative;');
      expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
      expect(raw).toContain('<bot@acme.test>');
      expect(raw).toContain('Reply-To: sales@tenant.test');
    });

    it("puts the gateway's Message-ID and the threading headers on the wire", async () => {
      await adapter.send({
        config: cfg(OAUTH),
        to: 'lead@x.test',
        subject: 'Re: teklif',
        text: 'merhaba',
        messageId: '<ml-1@jeetagrowth.com>',
        inReplyTo: 'prev@x.test',
        references: ['prev@x.test'],
        autoSubmitted: 'auto-replied',
      });
      const raw = wire();
      expect(raw).toContain('Message-ID: <ml-1@jeetagrowth.com>');
      expect(raw).toContain('In-Reply-To: <prev@x.test>');
      expect(raw).toContain('Auto-Submitted: auto-replied');
    });

    it('refreshes an expired token on demand and sends with the one it got back', async () => {
      // "try again shortly" was a real failure on a real customer's mail: the
      // sweep is the floor, not the ceiling.
      oauthRefresh.refreshNow.mockResolvedValue({ accessToken: 'fresh', expiresAt: null, error: null });
      const res = await adapter.send({ config: cfg(DEAD), to: 'lead@x.test', text: 'hi', subject: 'S' });
      expect(res.status).toBe('SENT');
      expect(oauthRefresh.refreshNow).toHaveBeenCalledWith('ws-1', 'ch-1');
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
    });

    it('does not ask for a refresh while the stored token is still good', async () => {
      await adapter.send({ config: cfg(OAUTH), to: 'lead@x.test', text: 'hi', subject: 'S' });
      expect(oauthRefresh.refreshNow).not.toHaveBeenCalled();
    });

    it("reports the provider's own refusal when the token cannot be refreshed", async () => {
      oauthRefresh.refreshNow.mockResolvedValue({
        accessToken: null,
        expiresAt: null,
        error: 'invalid_grant: Token has been expired or revoked.',
      });
      const res = await adapter.send({ config: cfg(DEAD), to: 'lead@x.test', text: 'hi', subject: 'S' });
      expect(res).toMatchObject({ status: 'FAILED', error: expect.stringContaining('invalid_grant') });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refreshes on healthCheck too, so a mailbox that only needs a token is not called broken', async () => {
      oauthRefresh.refreshNow.mockResolvedValue({ accessToken: 'fresh', expiresAt: null, error: null });
      const res = await adapter.healthCheck(cfg(DEAD));
      expect(res.ok).toBe(true);
      expect(res.details).toMatchObject({ transport: 'oauth', send: true });
    });

    it('still reports a mailbox whose consent was revoked as unhealthy', async () => {
      oauthRefresh.refreshNow.mockResolvedValue({ accessToken: null, expiresAt: null, error: 'invalid_grant' });
      const res = await adapter.healthCheck(cfg(DEAD));
      expect(res.ok).toBe(false);
      expect(String(res.details?.reason)).toContain('invalid_grant');
    });
  });
});
