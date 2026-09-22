import { classifySmtpError } from './smtp-error';

/**
 * What a failed send MEANS.
 *
 * Today every error is the same thing: the campaign sender writes `FAILED` and
 * moves on, so a relay that was down for one minute burns the whole audience
 * permanently, and an AI reply that hit a 4xx is never tried again. The other
 * half of the same mistake is worse: treating any 5xx as a dead address would
 * suppress a whole list the first time a receiver answered `550 5.7.1` to a
 * policy check.
 *
 * So the 5xx bounce set is an ALLOW-LIST — the enhanced codes that mean "this
 * mailbox does not exist" and nothing else. Everything else 5xx is `unknown`:
 * honest, terminal for this attempt, and NOT a reason to suppress anybody.
 */
describe('classifySmtpError', () => {
  describe('transient — retry is the right answer', () => {
    it.each([421, 450, 451, 452])('treats %s as transient', (code) => {
      const c = classifySmtpError({ responseCode: code, response: `${code} try later` });
      expect(c).toMatchObject({ kind: 'transient', retriable: true, code });
    });

    it.each(['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ECONNECTION', 'EDNS'])(
      'treats the %s network failure as transient',
      (code) => {
        expect(classifySmtpError({ code })).toMatchObject({ kind: 'transient', retriable: true });
      },
    );

    it('treats a busy server and the OAuth "try again shortly" as transient', () => {
      expect(classifySmtpError('421 too many connections from your host')).toMatchObject({
        kind: 'transient',
        retriable: true,
      });
      // The adapter's own words when a consent mailbox token is mid-refresh.
      expect(
        classifySmtpError(
          'the connected mailbox token has expired and has not been refreshed yet — it renews automatically, try again shortly',
        ),
      ).toMatchObject({ kind: 'transient', retriable: true });
    });

    it('reads the enhanced code out of a 4xx response', () => {
      expect(classifySmtpError({ responseCode: 452, response: '452 4.2.2 Mailbox full' })).toMatchObject({
        kind: 'transient',
        code: 452,
        enhanced: '4.2.2',
      });
    });
  });

  describe('systemic — the tenant is misconfigured, not the recipient', () => {
    it.each([530, 534, 535])('treats the %s auth refusal as systemic and NOT retriable', (code) => {
      // Retrying the same message with the same rejected credentials cannot
      // succeed. The queue may still put the row back (that is `kind`'s job);
      // the transport must not spin on it.
      expect(classifySmtpError({ responseCode: code, response: `${code} 5.7.8 auth failed` })).toMatchObject({
        kind: 'systemic',
        retriable: false,
      });
    });

    it('never marks EAUTH retriable, whatever else the error carries', () => {
      expect(classifySmtpError({ code: 'EAUTH', responseCode: 535 })).toMatchObject({
        kind: 'systemic',
        retriable: false,
      });
      // Even when nodemailer reports EAUTH with a transient-looking network code.
      expect(classifySmtpError({ code: 'EAUTH', message: 'connection timeout' })).toMatchObject({
        retriable: false,
      });
    });

    it('recognises our own systemic refusals by their words', () => {
      for (const message of [
        'MESSAGES_EXHAUSTED',
        'SMTP credentials missing',
        'PUBLIC_BASE_URL not configured (unsubscribe link required)',
      ]) {
        expect(classifySmtpError(message)).toMatchObject({ kind: 'systemic', retriable: false });
      }
      expect(classifySmtpError({ code: 'MESSAGES_EXHAUSTED' })).toMatchObject({ kind: 'systemic' });
      // MessageQuotaService throws a Nest ForbiddenException, so the code sits
      // on the response OBJECT — where nodemailer keeps a response STRING.
      expect(
        classifySmtpError({
          response: { code: 'MESSAGES_EXHAUSTED', message: 'Monthly message limit reached (5000)' },
        }),
      ).toMatchObject({ kind: 'systemic', retriable: false });
    });
  });

  describe('permanent-recipient — the allow-list, and only the allow-list', () => {
    it.each(['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10'])(
      'accepts the enhanced code %s as a real bounce',
      (enhanced) => {
        const c = classifySmtpError({
          responseCode: 550,
          response: `550 ${enhanced} <a@example.com>: recipient rejected`,
        });
        expect(c).toMatchObject({ kind: 'permanent-recipient', retriable: false, enhanced });
      },
    );

    it.each([550, 551, 553])('accepts %s when the text says the mailbox does not exist', (code) => {
      expect(classifySmtpError({ responseCode: code, response: `${code} User unknown` })).toMatchObject({
        kind: 'permanent-recipient',
      });
      expect(classifySmtpError({ responseCode: code, response: `${code} No such user here` })).toMatchObject({
        kind: 'permanent-recipient',
      });
      expect(
        classifySmtpError({ responseCode: code, response: `${code} Recipient address rejected` }),
      ).toMatchObject({ kind: 'permanent-recipient' });
    });

    it('does NOT treat 550 5.7.1 as a bounce — that is the sender being refused', () => {
      // This single line is what stops one bad relay hour from suppressing an
      // entire audience. 5.7.1 is policy, not a dead mailbox.
      const c = classifySmtpError({ responseCode: 550, response: '550 5.7.1 Message rejected by policy' });
      expect(c).toMatchObject({ kind: 'unknown', retriable: false, code: 550, enhanced: '5.7.1' });
    });

    it.each([
      ['554 5.7.1 Service unavailable; client blocked', 554, '5.7.1'],
      ['552 5.3.4 Message size exceeds fixed limit', 552, '5.3.4'],
      ['550 5.1.8 Sender address rejected: domain not found', 550, '5.1.8'],
      ['550 5.7.26 Unauthenticated email is not accepted', 550, '5.7.26'],
    ])('leaves the sender-side refusal %s as unknown', (response, code, enhanced) => {
      expect(classifySmtpError({ responseCode: code, response })).toMatchObject({
        kind: 'unknown',
        retriable: false,
        enhanced,
      });
    });
  });

  describe('the answers nobody can be sure about', () => {
    it('never retries a timeout that happened at DATA', () => {
      // nodemailer cannot tell accepted-then-timed-out from rejected, and a
      // retry there is a second copy of a real mail in a customer's inbox.
      expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'DATA' })).toMatchObject({
        kind: 'unknown',
        retriable: false,
      });
      expect(
        classifySmtpError({ code: 'ESOCKET', message: 'Socket timeout while sending DATA' }),
      ).toMatchObject({ kind: 'unknown', retriable: false });
    });

    it('answers unknown for nothing at all, rather than guessing', () => {
      for (const input of [undefined, null, '', {}, 0]) {
        expect(classifySmtpError(input)).toEqual({ kind: 'unknown', retriable: false });
      }
    });

    it('reads a plain string, an Error and a nodemailer error alike', () => {
      // The campaign sender only ever has the adapter's `error` string.
      expect(classifySmtpError('451 4.3.0 temporary local problem')).toMatchObject({
        kind: 'transient',
        code: 451,
        enhanced: '4.3.0',
      });
      expect(classifySmtpError(new Error('550 5.1.1 user unknown'))).toMatchObject({
        kind: 'permanent-recipient',
        code: 550,
      });
      expect(
        classifySmtpError({ responseCode: 550, response: '550 5.1.1 user unknown', message: 'Message failed' }),
      ).toMatchObject({ kind: 'permanent-recipient' });
    });

    it('does not mistake a number inside prose for a status code', () => {
      expect(classifySmtpError('Message failed: unexpected end of data')).toEqual({
        kind: 'unknown',
        retriable: false,
      });
    });
  });
});
