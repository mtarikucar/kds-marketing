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
  /**
   * The INCOMING (IMAP) server for the same provider, where one exists.
   *
   * It lives in THIS table rather than in a second one because "who runs this
   * domain's mail" is a single fact, and two tables answering it would drift
   * the moment one of them gained a provider. Absent means we do not know —
   * pure-outbound relays (Mailgun) have no IMAP at all, and inventing
   * `imap.<whatever>` by string surgery on the SMTP host is exactly the
   * guessing this file refuses to do.
   *
   * Every entry is implicit TLS on 993; STARTTLS on 143 is not offered,
   * because a mailbox password is the payload and there is no provider here
   * that requires the downgrade.
   */
  imap?: { host: string; port: number };
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
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false, provider: 'Google', oauth: 'GOOGLE', imap: { host: 'imap.gmail.com', port: 993 } },
  },
  {
    suffix: 'googlemail.com',
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false, provider: 'Google', oauth: 'GOOGLE', imap: { host: 'imap.gmail.com', port: 993 } },
  },
  {
    suffix: 'protection.outlook.com',
    smtp: { host: 'smtp.office365.com', port: 587, secure: false, provider: 'Microsoft 365', oauth: 'MICROSOFT', imap: { host: 'outlook.office365.com', port: 993 } },
  },
  {
    suffix: 'outlook.com',
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, provider: 'Outlook', oauth: 'MICROSOFT', imap: { host: 'outlook.office365.com', port: 993 } },
  },
  // GoDaddy's own mail product. Note the outgoing host is NOT the MX host:
  // mail arrives at smtp.secureserver.net and leaves through smtpout — a
  // difference that has cost people an afternoon more than once.
  {
    suffix: 'secureserver.net',
    smtp: { host: 'smtpout.secureserver.net', port: 587, secure: false, provider: 'GoDaddy', imap: { host: 'imap.secureserver.net', port: 993 } },
  },
  { suffix: 'yandex.net', smtp: { host: 'smtp.yandex.com', port: 465, secure: true, provider: 'Yandex', imap: { host: 'imap.yandex.com', port: 993 } } },
  { suffix: 'yandex.ru', smtp: { host: 'smtp.yandex.com', port: 465, secure: true, provider: 'Yandex', imap: { host: 'imap.yandex.com', port: 993 } } },
  { suffix: 'zoho.com', smtp: { host: 'smtp.zoho.com', port: 587, secure: false, provider: 'Zoho', imap: { host: 'imap.zoho.com', port: 993 } } },
  { suffix: 'zoho.eu', smtp: { host: 'smtp.zoho.eu', port: 587, secure: false, provider: 'Zoho', imap: { host: 'imap.zoho.eu', port: 993 } } },
  { suffix: 'mail.ru', smtp: { host: 'smtp.mail.ru', port: 465, secure: true, provider: 'Mail.ru', imap: { host: 'imap.mail.ru', port: 993 } } },
  { suffix: 'yahoodns.net', smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true, provider: 'Yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993 } } },
  { suffix: 'icloud.com', smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, provider: 'iCloud', imap: { host: 'imap.mail.me.com', port: 993 } } },
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

/**
 * The incoming (IMAP) server for a mailbox we already know the OUTGOING server
 * of — null when the provider is unrecognised or has no IMAP.
 *
 * The inbound poller needs a host and holds an already-configured channel, so
 * it asks by SMTP host rather than by address: that answer is exact, needs no
 * DNS round trip on every tick, and stays correct for a mailbox whose host was
 * typed by hand instead of discovered. `suggestSmtp` remains the entry point
 * when all you have is an address.
 *
 * Note Microsoft: the host is right, but basic-auth IMAP is switched off on
 * Microsoft 365, so a password connection there fails at LOGIN. It is listed
 * anyway — the server's own refusal names the problem, while returning null
 * would report the far more misleading "provider not recognised".
 */
export function imapForSmtpHost(smtpHost: string): { host: string; port: number } | null {
  const host = String(smtpHost ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  for (const { smtp } of BY_MX_SUFFIX) {
    if (smtp.host === host && smtp.imap) return { ...smtp.imap };
  }
  return null;
}
