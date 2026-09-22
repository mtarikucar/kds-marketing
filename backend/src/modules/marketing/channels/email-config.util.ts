import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import addressparser from 'nodemailer/lib/addressparser';
import { isBlockedIp } from '../../../common/util/safe-fetch';
import {
  hasHeaderInjection,
  isSingleAddress,
  normalizeAddress,
} from '../../../common/util/email-address';
import { domainOf } from './smtp-autodiscover';

/**
 * What a mailbox's credentials have to be true for, checked at the moment the
 * operator types them.
 *
 * ## Why here and not at dial time
 *
 * Every other reader of these secrets is a background job. `EmailChannelAdapter`
 * sends, `EmailImapPollService` polls every five minutes, `EmailImapIdleService`
 * holds a connection open — none of them has a human watching. A host that
 * resolves to `169.254.169.254`, a `From` that is prose, a port with a digit too
 * many: each of those fails silently, hours later, in a log. Refusing at the
 * write path is one choke point that closes verify, send and both IMAP services
 * at once, and it is the only place where the answer reaches the person who can
 * fix it (`smtp-ssrf`).
 *
 * ## What it deliberately does NOT do
 *
 * - It does not require the `From` to match `smtpUser`. SendGrid's login is
 *   literally `apikey`, Mailgun's is `postmaster@mg.<domain>`, SES's is an IAM
 *   key id. That rule would refuse every relay on the market.
 * - It does not guess an IMAP host from the SMTP host. Both pollers consume
 *   `imapTarget()` unconditionally, so a blanket default would start
 *   five-minutely logins against hosts nobody proved.
 * - It is not a substitute for a dial-time check. DNS can be repointed after
 *   the save, and rows sealed before this guard existed are still out there.
 */

/** The one sentence a blocked host gets, wherever it is blocked. */
export const BLOCKED_MAIL_HOST = 'that mail server address is not allowed';

/** A host is a hostname. Anything that carries a port, a scheme or a path is a
 *  typo we can name precisely instead of failing at connect time. */
const HOST_SHAPE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/i;

export interface ParsedFrom {
  address: string;
  name: string;
}

/**
 * The real address in a `From`-shaped value, and its label, as two values.
 *
 * Same rule the adapter parses inbound mail with, and for the same reason: a
 * first-`<>` regex reads the address out of the DISPLAY NAME, so
 * `"<ceo@victim>" <attacker@evil>` resolves to the victim
 * (`from-display-name-spoof`).
 */
export function parseFromAddress(raw: string | null | undefined): ParsedFrom {
  for (const entry of addressparser(String(raw ?? ''), { flatten: true })) {
    const address = normalizeAddress(entry.address);
    if (address && isSingleAddress(address)) {
      return { address, name: String(entry.name ?? '').trim() };
    }
  }
  return { address: '', name: '' };
}

/**
 * The domain the PLATFORM transport sends as, read from the same env the
 * platform sender reads (`EMAIL_FROM`, then `EMAIL_USER`) rather than
 * hard-coded — a deploy that moves its sending domain must move this rule with
 * it. Null when the platform has no sender configured, which makes the rule
 * below inert instead of wrong.
 */
export function platformSenderDomain(): string | null {
  const from = (process.env.EMAIL_FROM || process.env.EMAIL_USER || '').trim();
  return from ? domainOf(from) : null;
}

/**
 * Refuse a mail host that is not a public name.
 *
 * Bare IP literals are refused outright, public ones included: a mail server
 * reached by address alone cannot present a matching certificate, and allowing
 * the shape is what makes the DNS check skippable. Every resolved address is
 * checked, so a split-horizon name that answers with one public and one private
 * record is refused too.
 */
export async function assertMailHostSafe(host: string, field = 'host'): Promise<void> {
  const raw = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!raw) throw new BadRequestException(`${field} is empty.`);
  if (hasHeaderInjection(raw)) {
    throw new BadRequestException(`${field}: ${BLOCKED_MAIL_HOST}.`);
  }
  if (isIP(raw)) {
    throw new BadRequestException(
      `${field}: enter the mail server's host NAME (mail.firma.com.tr), not an IP address.`,
    );
  }
  if (!HOST_SHAPE_RE.test(raw)) {
    throw new BadRequestException(
      `${field}: "${raw}" is not a host name. Enter the server name only — the port goes in its own field.`,
    );
  }

  let records: Array<{ address: string }>;
  try {
    records = await lookup(raw, { all: true });
  } catch {
    // Named, because the overwhelmingly common cause is a typo in the host and
    // the operator can see it the moment we read it back to them.
    throw new BadRequestException(`${field}: we could not resolve "${raw}". Check the spelling.`);
  }
  if (!records.length) {
    throw new BadRequestException(`${field}: we could not resolve "${raw}". Check the spelling.`);
  }
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new BadRequestException(`${field}: ${BLOCKED_MAIL_HOST} ("${raw}" points inside a private network).`);
    }
  }
}

/** A port is a port. A stray digit fails at connect time with nothing to read,
 *  and `Number('nope')` would otherwise sail through as NaN. */
function assertPort(value: string, field: string): void {
  if (!value) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new BadRequestException(`${field} must be a port number between 1 and 65535 (got "${value}").`);
  }
}

/**
 * Validate an EMAIL channel's secrets at save time — the counterpart of
 * `assertNetgsmSmsSecrets`, covering the IMAP half as well because both
 * pollers read `imapHost`/`imapPort` straight out of these secrets.
 *
 * Async because the host guard has to ask DNS: a name is only safe once we know
 * what it answers with.
 */
export async function assertEmailSecrets(secrets: Record<string, string> | undefined): Promise<void> {
  const s = secrets ?? {};
  const val = (k: string) => (typeof s[k] === 'string' ? s[k].trim() : '');

  const smtpHost = val('smtpHost');
  const imapHost = val('imapHost');
  const smtpUser = val('smtpUser');
  const smtpPass = typeof s.smtpPass === 'string' ? s.smtpPass : '';
  const oauthProvider = val('oauthProvider');
  const fromRaw = val('fromEmail');

  // 1) WHO the mail is from. `fromEmail` is handed to the transport verbatim as
  //    the address, with the display name passed separately, so a folded value
  //    would build a broken header rather than a pretty one.
  if (fromRaw && !isSingleAddress(fromRaw)) {
    const inner = parseFromAddress(fromRaw).address;
    throw new BadRequestException(
      inner
        ? `"fromEmail" must be the address on its own (${inner}) — the display name is set separately.`
        : `"fromEmail" is not an email address (got "${fromRaw.slice(0, 80)}").`,
    );
  }
  // The adapter falls back to the login when no From was given, so a mailbox
  // that only typed its address still has an identity.
  const from =
    (isSingleAddress(fromRaw) ? normalizeAddress(fromRaw) : null) ??
    (isSingleAddress(smtpUser) ? normalizeAddress(smtpUser) : null) ??
    '';

  // 2) The platform's own domain is not a tenant's to send as. It is DMARC
  //    p=reject with SPF -all and no per-tenant key, so the mail would be
  //    rejected outright — and a tenant sending as the platform is a
  //    phishing surface we would be hosting.
  const platform = platformSenderDomain();
  if (from && platform && domainOf(from) === platform) {
    throw new BadRequestException(
      `"${from}" is on the platform's own sending domain (${platform}). Use your own mailbox address — mail sent as ${platform} from another server is rejected by its DMARC policy.`,
    );
  }

  // 3) A transport that cannot be used is worse than none: the channel would
  //    look connected and every send would fail.
  if (smtpHost) {
    if (!smtpUser || !smtpPass) {
      throw new BadRequestException(
        'An outgoing (SMTP) server needs a user name and a password to sign in with.',
      );
    }
    if (!from) {
      throw new BadRequestException(
        'This mailbox needs a "fromEmail" — the address your customers will see and reply to.',
      );
    }
  } else if (oauthProvider && !from) {
    throw new BadRequestException('A connected mailbox must name the address it sends as.');
  }

  assertPort(val('smtpPort'), 'smtpPort');
  assertPort(val('imapPort'), 'imapPort');

  // 4) Both hosts, not just the outgoing one — `imapHost` is dialled by two
  //    background services five-minutely and would be the quieter oracle.
  if (smtpHost) await assertMailHostSafe(smtpHost, 'smtpHost');
  if (imapHost) await assertMailHostSafe(imapHost, 'imapHost');
}
