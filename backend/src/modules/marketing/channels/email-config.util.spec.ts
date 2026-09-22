const mockLookup = jest.fn();

jest.mock('node:dns/promises', () => ({
  __esModule: true,
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { BadRequestException } from '@nestjs/common';
import {
  assertEmailSecrets,
  assertMailHostSafe,
  parseFromAddress,
  platformSenderDomain,
} from './email-config.util';

/**
 * Save-time validation of a mailbox's credentials.
 *
 * Everything here is about the moment the operator presses Save, because that
 * is the only moment they are still looking. A mail host that resolves inside
 * our own network, a `From` that is prose rather than an address, a `From` on
 * the platform's own DMARC-rejecting domain — each of them fails LATER, in a
 * poller log or a bounced customer mail, unless it is refused here by name.
 */
describe('email-config.util', () => {
  /** A public A record, so the host guard's happy path needs no network. */
  const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue(PUBLIC);
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_USER;
  });

  describe('parseFromAddress', () => {
    it('reads the real address out of a display-name form', () => {
      expect(parseFromAddress('"Firma A.Ş." <info@firma.com.tr>')).toEqual({
        address: 'info@firma.com.tr',
        name: 'Firma A.Ş.',
      });
    });

    it('is not fooled by an address hidden in the display name', () => {
      // The old first-`<>` regex filed this mail under the CEO. The deliverable
      // address is the one after the display name, and nothing else.
      expect(parseFromAddress('"<ceo@victim.com>" <attacker@evil.com>').address).toBe(
        'attacker@evil.com',
      );
    });

    it('returns nothing for prose', () => {
      expect(parseFromAddress('hi there')).toEqual({ address: '', name: '' });
    });
  });

  describe('platformSenderDomain', () => {
    it('is the domain of the platform transport, not a hard-coded string', () => {
      process.env.EMAIL_FROM = 'no-reply@jeetagrowth.com';
      expect(platformSenderDomain()).toBe('jeetagrowth.com');
    });

    it('falls back to EMAIL_USER, and is null when the platform has no sender', () => {
      process.env.EMAIL_USER = 'admin@jeetagrowth.com';
      expect(platformSenderDomain()).toBe('jeetagrowth.com');
      delete process.env.EMAIL_USER;
      expect(platformSenderDomain()).toBeNull();
    });
  });

  describe('assertMailHostSafe', () => {
    it('accepts a host that resolves publicly', async () => {
      await expect(assertMailHostSafe('smtp.firma.com.tr', 'smtpHost')).resolves.toBeUndefined();
      expect(mockLookup).toHaveBeenCalledWith('smtp.firma.com.tr', { all: true });
    });

    it('refuses a host that resolves inside the network', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      await expect(assertMailHostSafe('mail.internal', 'smtpHost')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a host where ANY resolved address is internal', async () => {
      mockLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
      await expect(assertMailHostSafe('split.horizon.test', 'smtpHost')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a bare IP literal without asking DNS', async () => {
      await expect(assertMailHostSafe('93.184.216.34', 'smtpHost')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('refuses a host we cannot resolve, naming it', async () => {
      mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
      await expect(assertMailHostSafe('smpt.firma.com', 'smtpHost')).rejects.toThrow(
        /smpt\.firma\.com/,
      );
    });

    it('refuses a host with a port glued on, and says where the port goes', async () => {
      await expect(assertMailHostSafe('mail.firma.com:993', 'imapHost')).rejects.toThrow(
        /imapHost/,
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });
  });

  describe('assertEmailSecrets', () => {
    const SMTP = {
      smtpHost: 'smtp.firma.com.tr',
      smtpPort: '587',
      smtpUser: 'info@firma.com.tr',
      smtpPass: 'hunter2',
      fromEmail: 'info@firma.com.tr',
    };

    it('accepts an ordinary mailbox', async () => {
      await expect(assertEmailSecrets(SMTP)).resolves.toBeUndefined();
    });

    it('accepts an ESP relay whose login is not an address', async () => {
      // SendGrid's user is literally `apikey`, Mailgun's is
      // `postmaster@mg.<domain>`, SES's is an IAM key id — requiring the From to
      // MATCH the login would refuse every relay in the market.
      await expect(
        assertEmailSecrets({ ...SMTP, smtpUser: 'apikey', smtpPass: 'SG.xxx' }),
      ).resolves.toBeUndefined();
    });

    it('refuses an SMTP host that resolves to a private address', async () => {
      mockLookup.mockResolvedValue([{ address: '192.168.1.25', family: 4 }]);
      await expect(assertEmailSecrets(SMTP)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an IMAP host that resolves to a private address', async () => {
      mockLookup.mockImplementation(async (host: string) =>
        host === 'imap.internal' ? [{ address: '169.254.169.254', family: 4 }] : PUBLIC,
      );
      await expect(
        assertEmailSecrets({ ...SMTP, imapHost: 'imap.internal' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a From that is not an address', async () => {
      await expect(
        assertEmailSecrets({ ...SMTP, fromEmail: 'hi there' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a From carrying a display name, and says to enter the address alone', async () => {
      // The adapter passes `fromEmail` verbatim as the ADDRESS and sets the
      // display name separately, so a folded value would build a broken header.
      await expect(
        assertEmailSecrets({ ...SMTP, fromEmail: '"Firma" <info@firma.com.tr>' }),
      ).rejects.toThrow(/info@firma\.com\.tr/);
    });

    it("refuses a From on the platform's own sending domain", async () => {
      process.env.EMAIL_FROM = 'no-reply@jeetagrowth.com';
      await expect(
        assertEmailSecrets({ ...SMTP, fromEmail: 'destek@jeetagrowth.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('leaves the platform-domain rule inert when the platform has no sender configured', async () => {
      await expect(
        assertEmailSecrets({ ...SMTP, fromEmail: 'destek@jeetagrowth.com' }),
      ).resolves.toBeUndefined();
    });

    it('refuses an SMTP host with no login to use it with', async () => {
      await expect(
        assertEmailSecrets({ smtpHost: 'smtp.firma.com.tr', fromEmail: 'info@firma.com.tr' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a mailbox that names no sending identity at all', async () => {
      await expect(
        assertEmailSecrets({ smtpHost: 'smtp.firma.com.tr', smtpUser: 'apikey', smtpPass: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a port that is not a port', async () => {
      await expect(assertEmailSecrets({ ...SMTP, smtpPort: '5870000' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(assertEmailSecrets({ ...SMTP, imapPort: 'nope' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts a consent-connected mailbox, which has no host to check', async () => {
      await expect(
        assertEmailSecrets({
          oauthProvider: 'google',
          oauthAccessToken: 'tok',
          fromEmail: 'info@firma.com.tr',
        }),
      ).resolves.toBeUndefined();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('refuses a CRLF smuggled into the From', async () => {
      await expect(
        assertEmailSecrets({ ...SMTP, fromEmail: 'info@firma.com.tr\r\nBcc: spy@evil.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
