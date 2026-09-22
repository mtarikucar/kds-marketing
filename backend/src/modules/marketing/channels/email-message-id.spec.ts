import { newMessageId, normalizeMessageId, toHeaderMessageId } from './email-message-id';

/**
 * One spelling of a Message-ID.
 *
 * The same id arrives with angle brackets from an IMAP header, without them
 * from `info.messageId`, and with a mixed-case domain from whichever server
 * generated it. Threading, Sent-folder dedupe and DSN attribution are all
 * equality checks, so every one of them has to be done on the same spelling —
 * normalize BOTH sides of every lookup or the match silently never happens.
 *
 * `newMessageId` exists so the id is OURS and deterministic: a resend of the
 * same ledger row produces the same id, which is what lets the Sent-folder
 * poller recognise its own mail instead of filing it as an inbound reply.
 */
describe('email-message-id', () => {
  describe('normalizeMessageId', () => {
    it('strips the angle brackets and lowercases only the domain', () => {
      // The local part is case-sensitive per RFC 5322; lowercasing it would
      // break equality against the server that issued it.
      expect(normalizeMessageId('<AbC123@Mail.Example.COM>')).toBe('AbC123@mail.example.com');
      expect(normalizeMessageId('AbC123@Mail.Example.COM')).toBe('AbC123@mail.example.com');
    });

    it('takes the first bracketed id when a header carries a comment or a list', () => {
      expect(normalizeMessageId('<a@x.com> (added by postmaster)')).toBe('a@x.com');
      expect(normalizeMessageId('  <a@x.com>\r\n')).toBe('a@x.com');
    });

    it('answers null for the empties, so a null lookup key is never a wildcard', () => {
      expect(normalizeMessageId(undefined)).toBeNull();
      expect(normalizeMessageId(null)).toBeNull();
      expect(normalizeMessageId('')).toBeNull();
      expect(normalizeMessageId('   ')).toBeNull();
      expect(normalizeMessageId('<>')).toBeNull();
    });

    it('keeps an id it cannot parse rather than dropping the only key it has', () => {
      // Some servers emit a Message-ID with no domain at all. It is still the
      // only handle on that mail, so it is kept as-is.
      expect(normalizeMessageId('<no-domain-here>')).toBe('no-domain-here');
    });

    it('is idempotent — normalizing twice is normalizing once', () => {
      const once = normalizeMessageId('<AbC@Example.COM>');
      expect(normalizeMessageId(once)).toBe(once);
    });
  });

  describe('newMessageId', () => {
    it('is deterministic for the same ledger row, so a resend reuses the id', () => {
      const a = newMessageId('7b1f0c2e-1111-2222-3333-444455556666', 'jeetagrowth.com');
      const b = newMessageId('7b1f0c2e-1111-2222-3333-444455556666', 'jeetagrowth.com');
      expect(a).toBe(b);
      expect(a).toBe('7b1f0c2e-1111-2222-3333-444455556666@jeetagrowth.com');
    });

    it('takes the domain out of a From address, because that is what callers hold', () => {
      expect(newMessageId('log-1', 'Jeeta <no-reply@JeetaGrowth.com>')).toBe('log-1@jeetagrowth.com');
      expect(newMessageId('log-1', 'no-reply@jeetagrowth.com')).toBe('log-1@jeetagrowth.com');
    });

    it('produces a header-safe local part from whatever seed it was given', () => {
      expect(newMessageId('  Invoice 42/A  ', 'example.com')).toBe('invoice-42-a@example.com');
      expect(newMessageId('a\r\nBcc: evil@attacker.test', 'example.com')).toBe(
        'a-bcc-evil-attacker.test@example.com',
      );
      expect(newMessageId('---', 'example.com')).toBeNull();
    });

    it('answers null rather than emitting a malformed header', () => {
      // A missing or unusable domain is not an error worth failing a send for:
      // the transport generates its own id, which is strictly better than a
      // header no receiver will accept.
      expect(newMessageId('log-1', '')).toBeNull();
      expect(newMessageId('log-1', 'localhost')).toBeNull();
      expect(newMessageId('', 'example.com')).toBeNull();
      expect(newMessageId(null, null)).toBeNull();
    });

    it('comes back out of normalizeMessageId unchanged', () => {
      const id = newMessageId('log-1', 'example.com');
      expect(normalizeMessageId(id)).toBe(id);
      expect(normalizeMessageId(toHeaderMessageId(id))).toBe(id);
    });
  });

  describe('toHeaderMessageId', () => {
    it('wraps for the wire and never double-wraps', () => {
      expect(toHeaderMessageId('a@x.com')).toBe('<a@x.com>');
      expect(toHeaderMessageId('<a@x.com>')).toBe('<a@x.com>');
    });

    it('answers null when there is nothing to wrap', () => {
      expect(toHeaderMessageId('')).toBeNull();
      expect(toHeaderMessageId(null)).toBeNull();
      expect(toHeaderMessageId(undefined)).toBeNull();
    });
  });
});
