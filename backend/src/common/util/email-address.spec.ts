import {
  HeaderInjectionError,
  MAX_ADDRESS_LENGTH,
  SINGLE_ADDRESS_RE,
  assertNoHeaderInjection,
  hasHeaderInjection,
  isSingleAddress,
  normalizeAddress,
} from './email-address';

/**
 * One recipient, always.
 *
 * Every send path in this product takes a single `to` string and hands it
 * straight to a transport. Nothing ever checked that the string was ONE
 * address: `info@x.com; satis@x.com` fans one mail (and one unsubscribe token)
 * out to two people, and a `\r\n` turns the recipient field into a header
 * writer — the Gmail RFC-822 builder is a raw string join, so that one is real
 * injection, not a theory.
 *
 * The validator lives in `common/` because the three chokepoints that enforce
 * it (the platform mailer, the channel adapter, the OAuth sender) sit in three
 * different trees, and three hand-written regexes is exactly how they drift.
 */
describe('email-address', () => {
  describe('isSingleAddress', () => {
    it('accepts one ordinary address, including plus-addressing and a long TLD', () => {
      expect(isSingleAddress('info@example.com')).toBe(true);
      // Plus-addressing is how people tag their own mail; refusing it would
      // silently drop real customers.
      expect(isSingleAddress('satis+kampanya@example.com.tr')).toBe(true);
      expect(isSingleAddress('a.b-c_d@mail.example.technology')).toBe(true);
    });

    it('refuses a comma or semicolon list — one token must never cover two people', () => {
      // The failure this whole file exists for: one mail, one unsubscribe
      // token, two recipients.
      expect(isSingleAddress('info@example.com, satis@example.com')).toBe(false);
      expect(isSingleAddress('info@example.com; satis@example.com')).toBe(false);
      expect(isSingleAddress('info@example.com,satis@example.com')).toBe(false);
    });

    it('refuses CR/LF anywhere, so a recipient can never write a header', () => {
      expect(isSingleAddress('victim@example.com\r\nBcc: evil@attacker.test')).toBe(false);
      expect(isSingleAddress('victim@example.com\nBcc: evil@attacker.test')).toBe(false);
      // Trailing line breaks are refused too, not trimmed away: a bare CRLF at
      // the end of the To field ends the header block early and eats the body.
      expect(isSingleAddress('victim@example.com\r\n')).toBe(false);
      expect(isSingleAddress('\nvictim@example.com')).toBe(false);
    });

    it('refuses display-name and group syntax that nodemailer would happily deliver', () => {
      expect(isSingleAddress('"Name" <a@example.com>')).toBe(false);
      expect(isSingleAddress('<a@example.com>')).toBe(false);
      // A group with an empty list makes nodemailer send to nobody and report
      // success — a send that silently reached no one.
      expect(isSingleAddress('undisclosed-recipients:;')).toBe(false);
      expect(isSingleAddress('Team: a@example.com, b@example.com;')).toBe(false);
    });

    it('refuses the shapes that are not an address at all', () => {
      expect(isSingleAddress('')).toBe(false);
      expect(isSingleAddress('   ')).toBe(false);
      expect(isSingleAddress(undefined as any)).toBe(false);
      expect(isSingleAddress(null as any)).toBe(false);
      expect(isSingleAddress(123 as any)).toBe(false);
      // No dot in the domain: `root@localhost` is deliverable on a mail server
      // and meaningless to us — every real customer address is dotted.
      expect(isSingleAddress('root@localhost')).toBe(false);
      expect(isSingleAddress('nobody')).toBe(false);
      expect(isSingleAddress('a@@example.com')).toBe(false);
      expect(isSingleAddress('a b@example.com')).toBe(false);
      expect(isSingleAddress('a\tb@example.com')).toBe(false);
    });

    it('tolerates surrounding spaces, because every caller already trims', () => {
      // The adapter does `(to || '').trim()` before it sends; refusing a padded
      // address here would refuse mail that goes out fine today.
      expect(isSingleAddress('  info@example.com  ')).toBe(true);
    });

    it('holds the RFC 5321 254-character ceiling', () => {
      const domain = '@example.com';
      const ok = 'a'.repeat(MAX_ADDRESS_LENGTH - domain.length) + domain;
      expect(ok.length).toBe(MAX_ADDRESS_LENGTH);
      expect(isSingleAddress(ok)).toBe(true);
      expect(isSingleAddress('a' + ok)).toBe(false);
    });

    it('exports the regex so the two local copies in the tree can import it', () => {
      // `leads/email-hygiene.service.ts` and `channels/conversation-ai-engine.
      // service.ts` each keep their own looser copy; later packages delete
      // those and import this one.
      expect(SINGLE_ADDRESS_RE.test('info@example.com')).toBe(true);
      expect(SINGLE_ADDRESS_RE.test('info@example.com, x@y.com')).toBe(false);
    });
  });

  describe('header injection', () => {
    it('sees CR, LF and NUL in any header value, not just addresses', () => {
      expect(hasHeaderInjection('Teklifiniz hazır')).toBe(false);
      expect(hasHeaderInjection('Subject\r\nBcc: evil@attacker.test')).toBe(true);
      expect(hasHeaderInjection('Subject\nX-Evil: 1')).toBe(true);
      expect(hasHeaderInjection('Subject\rX-Evil: 1')).toBe(true);
      expect(hasHeaderInjection('Subject\u0000')).toBe(true);
      expect(hasHeaderInjection(undefined as any)).toBe(false);
    });

    it('returns the value so it can be asserted inline while composing', () => {
      expect(assertNoHeaderInjection('Teklifiniz hazır', 'Subject')).toBe('Teklifiniz hazır');
    });

    it('throws at the composition site, which is the only place a throw is the safe answer', () => {
      // The gateway never calls this — it uses the predicate and returns a
      // receipt (G2: nothing new throws). `buildRfc822` has no receipt to
      // return: refusing to build the message is the refusal.
      expect(() => assertNoHeaderInjection('a@x.com\r\nBcc: evil@attacker.test', 'To')).toThrow(
        HeaderInjectionError,
      );
      // The message names the field and never echoes the payload back into a log line.
      expect(() => assertNoHeaderInjection('a@x.com\nX: 1', 'To')).toThrow(/^To /);
      expect(() => assertNoHeaderInjection('a@x.com\nX: 1', 'To')).not.toThrow(/evil|Bcc/);
    });
  });

  describe('normalizeAddress', () => {
    it('matches the lead match-key rule exactly — trim and lowercase, null when empty', () => {
      // This has to agree with `utils/lead-normalize.ts:normalizeEmail`, or a
      // suppression hash taken here never matches the `emailNormalized` the
      // lead was stored under and the opt-out silently does nothing.
      expect(normalizeAddress('  INFO@Example.COM ')).toBe('info@example.com');
      expect(normalizeAddress('')).toBeNull();
      expect(normalizeAddress('   ')).toBeNull();
      expect(normalizeAddress(null)).toBeNull();
      expect(normalizeAddress(undefined)).toBeNull();
    });

    it('normalizes without judging — validity is isSingleAddress\'s question', () => {
      // A suppression row for a malformed address is harmless; refusing to
      // normalize it would mean the bad row can never be matched or lifted.
      expect(normalizeAddress('Nobody')).toBe('nobody');
    });
  });
});
