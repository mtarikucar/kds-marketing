import {
  DEFAULT_MAIL_LANG,
  MAIL_COPY,
  MAIL_LANGS,
  escapeHtml,
  mailReasonKey,
  resolveMailLang,
  t,
  tHtml,
  type MailCopyKey,
  type MailLang,
} from './mail-copy';

/**
 * Recipient-facing copy.
 *
 * Every string a CUSTOMER reads — the bulk footer, the 6563 sender-identity
 * block, the unsubscribe page, booking and invoice mail — was hard-coded
 * English, in a product whose primary market is Turkey. This module is the one
 * place that answers "in which language do we say this", and it has to answer
 * without importing anything: it is used from the gateway, from a cron, and
 * from a public controller that has no workspace in scope.
 *
 * The two rules the rest of the system leans on are asserted here: a gap
 * degrades to English instead of rendering a raw key, and a value interpolated
 * into HTML can never carry markup of its own.
 */
describe('mail-copy', () => {
  /** Present in `en`, deliberately absent from `ru` (see mail-copy.ru.ts). */
  const EN_ONLY_KEY = 'mail.reason.DAILY_CAP' as MailCopyKey;

  describe('resolveMailLang', () => {
    it('accepts the five locales the product actually ships', () => {
      // The frontend has exactly these dictionaries (frontend/src/i18n/locales).
      expect([...MAIL_LANGS].sort()).toEqual(['ar', 'en', 'ru', 'tr', 'uz']);
      for (const lang of MAIL_LANGS) expect(resolveMailLang(lang)).toBe(lang);
    });

    it('normalises case, region tags and stray whitespace', () => {
      expect(resolveMailLang('TR')).toBe('tr');
      expect(resolveMailLang('tr-TR')).toBe('tr');
      expect(resolveMailLang('tr_TR')).toBe('tr');
      expect(resolveMailLang('  ru  ')).toBe('ru');
    });

    it('falls back to English, never to Turkish', () => {
      // A workspace explicitly set to `defaultLanguage='en'` must stay English,
      // and an unknown tag must not silently flip a tenant's mail to Turkish.
      expect(DEFAULT_MAIL_LANG).toBe('en');
      expect(resolveMailLang('de')).toBe('en');
      expect(resolveMailLang('')).toBe('en');
      expect(resolveMailLang(null)).toBe('en');
      expect(resolveMailLang(undefined)).toBe('en');
    });
  });

  describe('lookup and fallback', () => {
    it('answers in the requested language', () => {
      expect(t('tr', 'unsubscribe.confirm.button')).toBe('Abonelikten çık');
      expect(t('en', 'unsubscribe.confirm.button')).toBe('Unsubscribe');
    });

    it('falls back to English for a key a locale does not carry', () => {
      // ar/ru/uz ship the recipient-facing half only; the operator-facing
      // reasons degrade to English rather than to a raw key.
      expect(MAIL_COPY.ru[EN_ONLY_KEY]).toBeUndefined();
      expect(t('ru', EN_ONLY_KEY)).toBe(MAIL_COPY.en[EN_ONLY_KEY]);
    });

    it('returns the key itself when nothing anywhere defines it', () => {
      // Never `undefined`, never an empty line in the middle of a customer's
      // mail: the key is ugly but it names the gap.
      const missing = 'no.such.key' as MailCopyKey;
      expect(t('tr', missing)).toBe('no.such.key');
      expect(t('en', missing)).toBe('no.such.key');
    });

    it('never throws on a null or undefined language or key', () => {
      expect(() => t(null, undefined as unknown as MailCopyKey)).not.toThrow();
      expect(t(undefined, null as unknown as MailCopyKey)).toBe('');
    });

    it('builds a reason key from a MailReason code', () => {
      expect(mailReasonKey('DAILY_CAP')).toBe('mail.reason.DAILY_CAP');
      expect(t('tr', mailReasonKey('QUOTA_EXHAUSTED'))).toBe('Aylık ileti kotası doldu.');
    });
  });

  describe('interpolation', () => {
    it('substitutes every occurrence of a placeholder', () => {
      expect(t('en', 'document.receipt.body', { number: 'INV-7', amount: '₺100' })).toBe(
        'We received your payment of ₺100 for invoice INV-7. Thank you.',
      );
    });

    it('accepts numbers as well as strings', () => {
      expect(t('en', 'auth.reset.body', { minutes: 30 })).toContain('30 minutes');
    });

    it('keeps the placeholder when a variable was not supplied', () => {
      // i18next's behaviour, and the honest one: a wrong sentence hides the
      // bug, a visible `{{when}}` names it.
      expect(t('en', 'booking.reminder.body')).toBe(
        'This is a reminder for your booking at {{when}}.',
      );
      expect(t('en', 'booking.reminder.body', { when: null })).toBe(
        'This is a reminder for your booking at {{when}}.',
      );
    });

    it('does not treat a value as a template', () => {
      // A business name of `{{url}}` must not pull the URL in after it.
      expect(t('en', 'footer.identity.tradeName', { value: '{{url}}', url: 'https://x' })).toBe(
        'Trade name: {{url}}',
      );
    });
  });

  describe('HTML safety', () => {
    it('escapes interpolated values for the HTML footer', () => {
      expect(tHtml('en', 'footer.identity.tradeName', { value: '<script>alert(1)</script>' })).toBe(
        'Trade name: &lt;script&gt;alert(1)&lt;/script&gt;',
      );
      expect(tHtml('en', 'footer.identity.contact', { value: `" onload="x` })).toBe(
        'Contact: &quot; onload=&quot;x',
      );
    });

    it('leaves the plain-text renderer alone', () => {
      // A text/plain body must not be full of `&amp;`.
      expect(t('en', 'footer.identity.tradeName', { value: 'Acme & Co' })).toBe(
        'Trade name: Acme & Co',
      );
    });

    it('escapes the five markup characters and nothing else', () => {
      expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
        '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
      );
      expect(escapeHtml('Ömer — 100₺')).toBe('Ömer — 100₺');
    });
  });

  describe('dictionary parity', () => {
    const placeholders = (value: string): string[] =>
      (value.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) ?? []).sort();

    it('ships Turkish for every English key', () => {
      // TR is the primary market: a gap there is a real regression, not a
      // graceful degradation.
      const missing = Object.keys(MAIL_COPY.en).filter((k) => !MAIL_COPY.tr[k as MailCopyKey]);
      expect(missing).toEqual([]);
    });

    it('defines no key a locale invented on its own', () => {
      const strays: string[] = [];
      for (const lang of MAIL_LANGS) {
        for (const key of Object.keys(MAIL_COPY[lang])) {
          if (!(key in MAIL_COPY.en)) strays.push(`${lang}:${key}`);
        }
      }
      expect(strays).toEqual([]);
    });

    it('keeps the same placeholders in every translation', () => {
      // A translator writing `{{isim}}` would ship a literal `{{isim}}` to a
      // customer; the English value is the contract.
      const drifted: string[] = [];
      for (const lang of MAIL_LANGS) {
        for (const [key, value] of Object.entries(MAIL_COPY[lang])) {
          const expected = placeholders(MAIL_COPY.en[key as MailCopyKey] ?? '');
          if (JSON.stringify(placeholders(value as string)) !== JSON.stringify(expected)) {
            drifted.push(`${lang}:${key}`);
          }
        }
      }
      expect(drifted).toEqual([]);
    });

    it('carries a line for every MailReason the gateway can return', () => {
      // Mirrors the MailReason union in outbound-mail.types.ts. A receipt whose
      // reason has no words is a refusal the tenant cannot act on.
      const reasons = [
        'SUPPRESSED_OPT_OUT',
        'SUPPRESSED_BOUNCE',
        'SUPPRESSED_INVALID',
        'SUPPRESSED_COMPLAINT',
        'SUPPRESSED_ERASED',
        'IYS_RET',
        'CONSENT_REQUIRED',
        'QUOTA_EXHAUSTED',
        'DAILY_CAP',
        'QUIET_HOURS',
        'WORKSPACE_INACTIVE',
        'SENDING_PAUSED',
        'NO_RECIPIENT',
        'BAD_RECIPIENT',
        'NO_UNSUBSCRIBE',
        'MISSING_PUBLIC_BASE_URL',
        'NOT_CONFIGURED',
        'TRANSIENT',
        'SYSTEMIC',
        'PERMANENT',
      ];
      for (const reason of reasons) {
        const key = mailReasonKey(reason);
        expect(MAIL_COPY.en[key]).toBeTruthy();
        expect(MAIL_COPY.tr[key]).toBeTruthy();
      }
    });

    it('never leaves a value blank', () => {
      const blanks: string[] = [];
      for (const lang of MAIL_LANGS) {
        for (const [key, value] of Object.entries(MAIL_COPY[lang])) {
          if (!String(value).trim()) blanks.push(`${lang}:${key}`);
        }
      }
      expect(blanks).toEqual([]);
    });

    it('exposes each locale under its own code', () => {
      for (const lang of MAIL_LANGS) {
        expect(MAIL_COPY[lang as MailLang]).toBeDefined();
      }
    });
  });
});
