import { promises as dns } from 'dns';

/**
 * Work out a mailbox's outgoing server from its address alone.
 *
 * The custom-SMTP form asks for five things — host, port, security, username,
 * password — and four of them are a property of the DOMAIN, not of the person.
 * Anyone connecting `admin@figurunica.com` has to go and find that GoDaddy's
 * outgoing server is `smtpout.secureserver.net` on 587, which is a support
 * ticket waiting to happen and a place to mistype.
 *
 * The domain's MX record already says who runs the mail. Reading it turns the
 * form into an address and a password.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: guess. An unrecognised MX returns null
 * and the form falls back to asking, because a wrong host does not fail at
 * connect time with a useful message — it fails later, intermittently, on a
 * customer's send.
 */

export interface SmtpSuggestion {
  host: string;
  port: number;
  secure: boolean;
  /** The provider we recognised, for the UI to name what it found. */
  provider: string;
  /**
   * True when this provider also supports connecting WITHOUT a password.
   * Offering "connect with Google" to someone about to type their Gmail
   * password into our form is the whole point of recognising the domain.
   */
  oauth?: 'GOOGLE' | 'MICROSOFT';
}

/**
 * MX suffix → outgoing server. Matched on the SUFFIX because providers answer
 * with per-customer hostnames (`alt1.aspmx.l.google.com`,
 * `figurunica-com.mail.protection.outlook.com`) and only the tail is stable.
 *
 * Ordered: the first match wins, so put anything specific above the generic
 * suffix it lives under.
 */
const BY_MX_SUFFIX: ReadonlyArray<{ suffix: string; smtp: SmtpSuggestion }> = [
  {
    suffix: 'google.com',
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false, provider: 'Google', oauth: 'GOOGLE' },
  },
  {
    suffix: 'googlemail.com',
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false, provider: 'Google', oauth: 'GOOGLE' },
  },
  {
    suffix: 'protection.outlook.com',
    smtp: { host: 'smtp.office365.com', port: 587, secure: false, provider: 'Microsoft 365', oauth: 'MICROSOFT' },
  },
  {
    suffix: 'outlook.com',
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, provider: 'Outlook', oauth: 'MICROSOFT' },
  },
  // GoDaddy's own mail product. Note the outgoing host is NOT the MX host:
  // mail arrives at smtp.secureserver.net and leaves through smtpout — a
  // difference that has cost people an afternoon more than once.
  {
    suffix: 'secureserver.net',
    smtp: { host: 'smtpout.secureserver.net', port: 587, secure: false, provider: 'GoDaddy' },
  },
  { suffix: 'yandex.net', smtp: { host: 'smtp.yandex.com', port: 465, secure: true, provider: 'Yandex' } },
  { suffix: 'yandex.ru', smtp: { host: 'smtp.yandex.com', port: 465, secure: true, provider: 'Yandex' } },
  { suffix: 'zoho.com', smtp: { host: 'smtp.zoho.com', port: 587, secure: false, provider: 'Zoho' } },
  { suffix: 'zoho.eu', smtp: { host: 'smtp.zoho.eu', port: 587, secure: false, provider: 'Zoho' } },
  { suffix: 'mail.ru', smtp: { host: 'smtp.mail.ru', port: 465, secure: true, provider: 'Mail.ru' } },
  { suffix: 'yahoodns.net', smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true, provider: 'Yahoo' } },
  { suffix: 'icloud.com', smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, provider: 'iCloud' } },
  { suffix: 'mailgun.org', smtp: { host: 'smtp.mailgun.org', port: 587, secure: false, provider: 'Mailgun' } },
];

/** The address's domain, lower-cased, or null when it is not an address. */
export function domainOf(address: string): string | null {
  const at = String(address ?? '').trim().toLowerCase().lastIndexOf('@');
  if (at <= 0) return null;
  const domain = String(address).trim().toLowerCase().slice(at + 1);
  // A trailing dot is legal in DNS and breaks a naive suffix match.
  return domain.replace(/\.$/, '') || null;
}

/** Match a set of MX hostnames against the table. Exported for the tests, which
 *  should not have to reach the network to pin the table's behaviour. */
export function suggestFromMxHosts(mxHosts: readonly string[]): SmtpSuggestion | null {
  const hosts = mxHosts.map((h) => String(h ?? '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  for (const { suffix, smtp } of BY_MX_SUFFIX) {
    // `endsWith` on a dot-prefixed suffix, so `notgoogle.com` cannot match
    // `google.com` — and the bare domain itself still can.
    if (hosts.some((h) => h === suffix || h.endsWith(`.${suffix}`))) return smtp;
  }
  return null;
}

/**
 * Look up the outgoing server for an address. Null when the domain has no MX,
 * the lookup fails, or the provider is not one we recognise — all three mean
 * the same thing to the caller: ask the person.
 */
export async function suggestSmtp(
  address: string,
  resolver: (domain: string) => Promise<Array<{ exchange: string }>> = dns.resolveMx,
): Promise<SmtpSuggestion | null> {
  const domain = domainOf(address);
  if (!domain) return null;
  try {
    const mx = await resolver(domain);
    return suggestFromMxHosts((mx ?? []).map((r) => r.exchange));
  } catch {
    // A domain with no MX, a timeout, a DNS server having a bad minute. None of
    // these is worth surfacing as an error on a form field the person can just
    // fill in themselves.
    return null;
  }
}
