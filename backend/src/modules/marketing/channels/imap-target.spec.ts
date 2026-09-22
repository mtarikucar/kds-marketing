import { classifyImapError, imapConnectOptions, imapTarget } from './imap-target';

const GODADDY = {
  smtpHost: 'smtpout.secureserver.net',
  smtpUser: 'admin@own.com',
  smtpPass: 'pw',
};

/** The happy answer, unwrapped — every host/port assertion below wants it. */
function target(secrets: Record<string, string | undefined>) {
  const result = imapTarget(secrets);
  if (result.kind !== 'ok') throw new Error(`expected a target, got refusal "${result.reason}"`);
  return result.target;
}

describe('imapTarget — one answer the poller and the idle hold both read', () => {
  it('discovers the incoming host from the outgoing one', () => {
    expect(target(GODADDY)).toMatchObject({ host: 'imap.secureserver.net', port: 993 });
  });

  it('prefers a hand-typed IMAP host over the discovered one', () => {
    expect(target({ ...GODADDY, imapHost: '  mail.firma.com.tr ' })).toMatchObject({
      host: 'mail.firma.com.tr',
    });
  });

  it('refuses to default the IMAP host to the SMTP host', () => {
    // The whole point of the refusal: a blanket default would start
    // five-minutely logins, and an IDLE reconnect loop, against hosts nobody
    // proved — including pure relays that have no IMAP at all.
    expect(imapTarget({ ...GODADDY, smtpHost: 'mail.unknown.example' })).toEqual({
      kind: 'refused',
      reason: 'no-host',
    });
  });

  it('names WHY it refused, so the poller can log a skip and not an error', () => {
    // A consent mailbox with nothing to read it WITH is send-only by design;
    // a mailbox with no password is half-configured. Neither is a failure
    // worth warning about every tick.
    expect(imapTarget({ oauthProvider: 'GOOGLE' })).toEqual({ kind: 'refused', reason: 'oauth' });
    expect(imapTarget({ smtpHost: GODADDY.smtpHost, smtpUser: 'a@b.com' })).toEqual({
      kind: 'refused',
      reason: 'no-credentials',
    });
    expect(imapTarget(undefined)).toEqual({ kind: 'refused', reason: 'no-credentials' });
  });

  describe('a consent mailbox that ALSO holds a receive credential', () => {
    // Gmail's readonly scope needs a CASA assessment, so "wait for the OAuth
    // read scope" means "no replies, indefinitely". Consent for send and an
    // app password for receive is two-way today, with no new scope and nobody
    // to wait for (A4.11 step 1).
    it('is pollable through its dedicated imapUser/imapPass', () => {
      expect(
        target({
          oauthProvider: 'GOOGLE',
          imapHost: 'imap.gmail.com',
          imapPort: '993',
          imapUser: 'owner@gmail.com',
          imapPass: 'app-password',
        }),
      ).toMatchObject({ host: 'imap.gmail.com', user: 'owner@gmail.com', pass: 'app-password' });
    });

    it('is pollable through a surviving smtpUser/smtpPass pair', () => {
      // `deadSmtpKeys` keeps that pair precisely when it is the mailbox's only
      // way in, so the resolver has to be willing to use it.
      expect(target({ ...GODADDY, oauthProvider: 'MICROSOFT' })).toMatchObject({
        host: 'imap.secureserver.net',
        user: 'admin@own.com',
      });
    });

    it('prefers the dedicated inbound pair, which consent never touches', () => {
      expect(
        target({
          ...GODADDY,
          oauthProvider: 'GOOGLE',
          imapUser: 'inbound@own.com',
          imapPass: 'inbound-pw',
        }),
      ).toMatchObject({ user: 'inbound@own.com', pass: 'inbound-pw' });
    });

    it('is still refused as oauth when there is nothing to read it with', () => {
      expect(imapTarget({ oauthProvider: 'GOOGLE', imapUser: 'owner@gmail.com' })).toEqual({
        kind: 'refused',
        reason: 'oauth',
      });
    });
  });

  it('keeps the credentials as typed — a password is not trimmed or cased', () => {
    const t = target({ ...GODADDY, smtpUser: ' Admin@Own.com ', smtpPass: ' pw ' });
    expect(t).toMatchObject({ user: 'Admin@Own.com', pass: ' pw ' });
  });

  describe('TLS — derived from the port, in ONE place', () => {
    it('is implicit TLS on 993 and 994', () => {
      expect(target({ ...GODADDY, imapPort: '993' }).secure).toBe(true);
      expect(target({ ...GODADDY, imapHost: 'imap.firma.com.tr', imapPort: '994' }).secure).toBe(true);
    });

    it('is a STARTTLS upgrade on 143', () => {
      expect(target({ ...GODADDY, imapHost: 'imap.tiny-host.example', imapPort: '143' })).toMatchObject({
        port: 143,
        secure: false,
      });
    });

    it('does not treat 465 as IMAPS — that is SMTPS, and a typo must fail loudly', () => {
      expect(target({ ...GODADDY, imapPort: '465' }).secure).toBe(false);
    });

    it('falls back to the discovered port when the stored one is not a number', () => {
      expect(target({ ...GODADDY, imapPort: 'abc' })).toMatchObject({ port: 993, secure: true });
    });
  });
});

describe('imapConnectOptions — the two services cannot drift', () => {
  it('demands the upgrade on a plaintext port instead of hoping for one', () => {
    // Without doSTARTTLS imapflow falls back to opportunistic STARTTLS and
    // sends LOGIN in cleartext to a server that has none. With it, the connect
    // throws and the failure is visible.
    const opts = imapConnectOptions(target({ ...GODADDY, imapHost: 'imap.x.example', imapPort: '143' }));
    expect(opts).toMatchObject({ secure: false, doSTARTTLS: true });
  });

  it('does not ask for an upgrade on an already-encrypted connection', () => {
    const opts = imapConnectOptions(target(GODADDY));
    expect(opts.secure).toBe(true);
    expect(opts).not.toHaveProperty('doSTARTTLS');
  });

  it('carries the credentials and keeps the client quiet', () => {
    expect(imapConnectOptions(target(GODADDY))).toMatchObject({
      host: 'imap.secureserver.net',
      port: 993,
      auth: { user: 'admin@own.com', pass: 'pw' },
      logger: false,
    });
  });

  it('bounds the handshake so a host that stops answering cannot hold a socket forever', () => {
    const opts = imapConnectOptions(target(GODADDY));
    expect(opts.greetingTimeout).toBeGreaterThan(0);
    expect(opts.connectionTimeout).toBeGreaterThan(0);
  });

  it('only bounds the SOCKET when the caller asks — an IDLE hold is silent by design', () => {
    // A socketTimeout on a held connection would kill a perfectly good mailbox
    // every 20 seconds. The poller, which is always talking, wants one.
    expect(imapConnectOptions(target(GODADDY))).not.toHaveProperty('socketTimeout');
    expect(imapConnectOptions(target(GODADDY), { socketTimeoutMs: 20_000 })).toMatchObject({
      socketTimeout: 20_000,
    });
  });
});

describe('classifyImapError — which ceiling the wait gets, never whether to stop', () => {
  it('reads imapflow own verdict on a refused login', () => {
    const e: any = new Error('Authentication failed');
    e.authenticationFailed = true;
    expect(classifyImapError(e)).toMatchObject({ authFailure: true, reason: 'AUTH_FAILED' });
  });

  it('reads the server response code, and the words, when the flag is absent', () => {
    const e: any = new Error('Invalid credentials (Failure)');
    e.serverResponseCode = 'AUTHENTICATIONFAILED';
    expect(classifyImapError(e).authFailure).toBe(true);
    expect(classifyImapError(new Error('LOGIN failed')).authFailure).toBe(true);
  });

  it('does not call a network failure an auth failure', () => {
    // It would earn the six-hour ceiling, and a mailbox behind a flaky link
    // would go quiet for a quarter of a day.
    const e: any = new Error('connect ECONNREFUSED 1.2.3.4:993');
    e.code = 'ECONNREFUSED';
    expect(classifyImapError(e)).toMatchObject({ authFailure: false, reason: 'CONNECT_FAILED' });
    expect(classifyImapError(new Error('Socket timeout')).authFailure).toBe(false);
  });

  it('keeps the server own words, truncated, for the operator', () => {
    expect(classifyImapError(new Error('x'.repeat(900))).error.length).toBeLessThanOrEqual(300);
    expect(classifyImapError('plain string').error).toBe('plain string');
    expect(classifyImapError(undefined).error).toBeTruthy();
  });
});
