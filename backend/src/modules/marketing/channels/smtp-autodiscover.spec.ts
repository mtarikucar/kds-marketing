import { domainOf, suggestFromMxHosts, suggestSmtp, imapForSmtpHost } from './smtp-autodiscover';

describe('SMTP autodiscovery — the server is a property of the domain, not the person', () => {
  describe('domainOf', () => {
    it('takes the LAST @, so a quoted local part cannot steal the domain', () => {
      expect(domainOf('"weird@name"@figurunica.com')).toBe('figurunica.com');
    });

    it('lower-cases and drops the root dot DNS allows', () => {
      expect(domainOf('Admin@FiguRunica.Com.')).toBe('figurunica.com');
    });

    it('refuses anything that is not an address', () => {
      expect(domainOf('figurunica.com')).toBeNull();
      expect(domainOf('@figurunica.com')).toBeNull();
      expect(domainOf('')).toBeNull();
    });
  });

  describe('the MX table', () => {
    it('reads GoDaddy, and knows the outgoing host is NOT the MX host', () => {
      // The real answer for figurunica.com: mail ARRIVES at smtp.secureserver.net
      // and LEAVES through smtpout. Returning the MX host here would produce a
      // form that looks right and cannot send.
      const s = suggestFromMxHosts(['smtp.secureserver.net', 'mailstore1.secureserver.net']);
      expect(s).toMatchObject({ host: 'smtpout.secureserver.net', port: 587, secure: false, provider: 'GoDaddy' });
    });

    it('recognises Google Workspace from a per-customer MX host', () => {
      const s = suggestFromMxHosts(['aspmx.l.google.com', 'alt1.aspmx.l.google.com']);
      expect(s).toMatchObject({ host: 'smtp.gmail.com', oauth: 'GOOGLE' });
    });

    it('recognises Microsoft 365 from its per-tenant MX host', () => {
      const s = suggestFromMxHosts(['figurunica-com.mail.protection.outlook.com']);
      expect(s).toMatchObject({ host: 'smtp.office365.com', oauth: 'MICROSOFT' });
    });

    it('matches on a dot boundary, so a look-alike domain is not mistaken for the provider', () => {
      // The bug a bare `endsWith` would ship: notgoogle.com ends with google.com.
      expect(suggestFromMxHosts(['mx.notgoogle.com'])).toBeNull();
    });

    it('says nothing rather than guessing for an unknown provider', () => {
      // A wrong host does not fail at connect time with a useful message — it
      // fails later, on a customer's send. Silence sends them to the field.
      expect(suggestFromMxHosts(['mx.some-tiny-host.example'])).toBeNull();
      expect(suggestFromMxHosts([])).toBeNull();
    });

    it('flags the providers that can be connected WITHOUT a password', () => {
      // The point of recognising the domain: nobody should type a Gmail
      // password into our form when consent is one click away.
      expect(suggestFromMxHosts(['aspmx.l.google.com'])?.oauth).toBe('GOOGLE');
      // GoDaddy's own mail has no OAuth, so it must NOT claim one.
      expect(suggestFromMxHosts(['smtp.secureserver.net'])?.oauth).toBeUndefined();
    });
  });

  describe('suggestSmtp', () => {
    it('resolves the address domain and answers from the table', async () => {
      const resolver = jest.fn().mockResolvedValue([{ exchange: 'smtp.secureserver.net' }]);
      const s = await suggestSmtp('admin@figurunica.com', resolver);
      expect(resolver).toHaveBeenCalledWith('figurunica.com');
      expect(s).toMatchObject({ host: 'smtpout.secureserver.net', provider: 'GoDaddy' });
    });

    it('treats a DNS failure as "ask the person", not as an error', async () => {
      const s = await suggestSmtp('a@b.com', jest.fn().mockRejectedValue(new Error('ENOTFOUND')));
      expect(s).toBeNull();
    });

    it('never reaches DNS for something that is not an address', async () => {
      const resolver = jest.fn();
      expect(await suggestSmtp('not-an-address', resolver)).toBeNull();
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});

/**
 * The incoming server rides in the SAME table as the outgoing one, because
 * "who runs this domain's mail" is a single fact and two tables answering it
 * would drift the moment one of them gained a provider.
 */
describe('imapForSmtpHost', () => {
  it('answers for a provider we recognise', () => {
    expect(imapForSmtpHost('smtpout.secureserver.net')).toEqual({
      host: 'imap.secureserver.net',
      port: 993,
    });
  });

  it('is case- and trailing-dot-insensitive, as hostnames are', () => {
    expect(imapForSmtpHost('SMTPOUT.SecureServer.NET.')).toEqual({
      host: 'imap.secureserver.net',
      port: 993,
    });
  });

  it('returns null for a pure-outbound relay that has no IMAP at all', () => {
    // Mailgun is in the table for sending. Inventing `imap.mailgun.org` by
    // string surgery would produce a host that fails at connect time on a
    // five-minute cron, forever.
    expect(imapForSmtpHost('smtp.mailgun.org')).toBeNull();
  });

  it('returns null rather than guessing at an unknown host', () => {
    expect(imapForSmtpHost('mail.some-host.example')).toBeNull();
    expect(imapForSmtpHost('')).toBeNull();
  });

  it('hands back a COPY, so a caller cannot mutate the shared table', () => {
    const a = imapForSmtpHost('smtpout.secureserver.net')!;
    a.port = 143;
    expect(imapForSmtpHost('smtpout.secureserver.net')).toEqual({
      host: 'imap.secureserver.net',
      port: 993,
    });
  });
});
