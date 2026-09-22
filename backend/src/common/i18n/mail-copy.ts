import { ar } from './mail-copy.ar';
import { en, type MailCopyKey } from './mail-copy.en';
import { ru } from './mail-copy.ru';
import { tr } from './mail-copy.tr';
import { uz } from './mail-copy.uz';

/**
 * Recipient-facing copy.
 *
 * Everything a customer reads — the bulk footer and its 6563 sender-identity
 * block, the unsubscribe page, booking and invoice mail — used to be written
 * in English inside whichever service happened to send it, in a product whose
 * primary market is Turkey. This is the one place that answers "in which
 * language do we say this".
 *
 * It imports nothing. The callers are a mail gateway, a cron and a public
 * controller that has no workspace (and no request context) in scope, so a
 * DI-shaped i18n service would be unusable in at least one of them; and
 * `marketing-decoupling.arch.spec.ts` requires anything under `common/` to
 * stay free of module-level coupling.
 *
 * Language comes from `OutboundMail.lang ?? Workspace.defaultLanguage`. There
 * is no new column and no new default: `Workspace.defaultLanguage` already
 * exists and already defaults to `'en'` (schema.prisma:37). Defaulting this
 * module to `'tr'` would flip every workspace explicitly set to English.
 */

export type { MailCopyKey };

/** The locales the product ships dictionaries for (frontend/src/i18n/locales). */
export const MAIL_LANGS = ['tr', 'en', 'ar', 'ru', 'uz'] as const;

export type MailLang = (typeof MAIL_LANGS)[number];

/** Not `tr`: see the note above about existing `defaultLanguage='en'` rows. */
export const DEFAULT_MAIL_LANG: MailLang = 'en';

export const MAIL_COPY: Readonly<Record<MailLang, Partial<Record<MailCopyKey, string>>>> = {
  tr,
  en,
  ar,
  ru,
  uz,
};

/** Values callers may interpolate. Anything else is treated as "not supplied". */
export type MailVars = Record<string, string | number | null | undefined>;

const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/**
 * `tr`, `TR`, `tr-TR` and `tr_TR` all mean Turkish; anything unknown, empty or
 * absent means English. Never throws — a public controller resolves a language
 * from a token and must not 500 because the row holds something odd.
 */
export function resolveMailLang(lang?: string | null): MailLang {
  const code = String(lang ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return (MAIL_LANGS as readonly string[]).includes(code)
    ? (code as MailLang)
    : DEFAULT_MAIL_LANG;
}

/**
 * The machine reason code the gateway returns becomes a dictionary key here,
 * so a `MailReceipt.reason` is never printed raw to a tenant.
 */
export function mailReasonKey(reason: string): MailCopyKey {
  return `mail.reason.${reason}` as MailCopyKey;
}

/**
 * Escape the five characters that can break out of HTML text or an attribute.
 * Exported because the HTML footer is assembled by the gateway, not here, and
 * it needs the same escaper for the pieces it adds itself.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain-text copy. A text/plain body must not be full of `&amp;`. */
export function t(lang: string | null | undefined, key: MailCopyKey, vars?: MailVars): string {
  return render(lookup(lang, key), vars, (v) => v);
}

/**
 * The same copy for an HTML part, with every interpolated value escaped. The
 * footer carries a tenant-authored trade name and address; without this a
 * business called `<script>` would run in the recipient's client.
 */
export function tHtml(lang: string | null | undefined, key: MailCopyKey, vars?: MailVars): string {
  return render(lookup(lang, key), vars, escapeHtml);
}

/**
 * Requested locale, then English, then the key itself. Returning the key is
 * deliberate: it is ugly in an inbox but it names the gap, where `undefined`
 * would print "undefined" and an empty string would silently drop a sentence.
 */
function lookup(lang: string | null | undefined, key: MailCopyKey): string {
  if (!key) return '';
  const dict = MAIL_COPY[resolveMailLang(lang)];
  return dict[key] ?? en[key] ?? String(key);
}

/**
 * Substitution is one pass over the TEMPLATE, never over the values, so a
 * contact named `{{url}}` cannot pull a variable in after itself.
 *
 * A placeholder with no value is left standing. That is i18next's behaviour
 * (which the frontend already relies on) and the honest one: a visible
 * `{{when}}` names the bug, while dropping it silently ships a wrong sentence.
 */
function render(template: string, vars: MailVars | undefined, encode: (v: string) => string): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    if (typeof value !== 'string' && typeof value !== 'number') return match;
    return encode(String(value));
  });
}
