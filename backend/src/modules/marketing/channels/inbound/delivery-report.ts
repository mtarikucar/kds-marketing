import { isSingleAddress, normalizeAddress } from '../../../../common/util/email-address';
import { normalizeMessageId } from '../email-message-id';
import {
  MailContentType,
  MailPart,
  RawMailHeaderLine,
  headerLineValues,
  parseAddressList,
} from './inbound-mail.types';

/**
 * Read a bounce, a complaint or a read receipt out of the mail that reports it.
 *
 * ## Why this is the live path
 *
 * Production sends over SMTP, not through an ESP, so the ONLY delivery feedback
 * that exists today is the DSN the receiving server mails back into the
 * tenant's own mailbox — and the poller skipped it unparsed as "mailer-daemon"
 * (`dsn-in-mailbox`). A typo'd address therefore showed SENT forever while
 * AI follow-ups kept mailing it. This path needs no ESP, no secret, no DNS and
 * no operator: it is the one that works on the day it ships.
 *
 * ## Pure, because the rules are where the bugs are
 *
 * Nothing here touches IMAP, Prisma or a provider SDK, so every rule below is a
 * unit test rather than an integration story.
 *
 * ## The rules that cost money if they are wrong
 *
 * - **One field block per recipient** (RFC 3464 §2.3). A report about three
 *   addresses carries three blocks with three `Status:` values, and reading
 *   only the first suppresses the wrong people.
 * - **`5.x.x` suppresses, `4.x.x` never does.** A 4.x.x is a full mailbox or
 *   greylisting; suppressing on one would blacklist a live customer over a
 *   transient queue. A mixed report suppresses only its 5.x.x rows.
 * - **A read receipt is not a bounce.** `disposition-notification` means the
 *   customer opened the mail — the friendliest possible signal, and the old
 *   code ingested it as if they had written prose.
 * - **ARF `abuse` is a COMPLAINT, never a HARD_BOUNCE.** They are different
 *   facts with different blast radii: `emailBouncedAt` is the flag another
 *   tenant's INVOICES refuse to send against (`esp-complaint-crosstenant`).
 * - **`Original-Message-ID` is often absent — accept the miss.**
 *   Address-level suppression is what actually stops future sends;
 *   per-recipient attribution onto `campaign_recipients.bouncedAt` is the
 *   bonus, and the deterministic `MailLog.messageId` is what makes it land.
 */

/** Which report shape this was, if any. */
export type DeliveryReportKind = 'DSN' | 'ARF' | 'MDN' | 'NONE';

/** What happened to one address. */
export type DeliveryOutcome =
  /** 5.x.x — the address does not work. Suppresses. */
  | 'HARD_BOUNCE'
  /** 4.x.x — full mailbox, greylisting, a queue. Never suppresses. */
  | 'SOFT_BOUNCE'
  /** The person pressed "spam". Suppresses, as an opt-out, not a dead address. */
  | 'COMPLAINT'
  /** A success DSN. */
  | 'DELIVERED'
  /** An MDN: they opened it. */
  | 'READ_RECEIPT'
  /** A report with no status we are willing to guess at. Never suppresses. */
  | 'UNKNOWN';

export interface DeliveryReportRecipient {
  /** Normalised address. */
  recipient: string;
  outcome: DeliveryOutcome;
  /** The enhanced status code (`5.1.1`), when the report carried or implied one. */
  status: string | null;
  action: string | null;
  diagnostic: string | null;
}

export interface DeliveryReport {
  kind: DeliveryReportKind;
  /** The id of the mail being reported on, normalised. Often null. */
  originalMessageId: string | null;
  recipients: DeliveryReportRecipient[];
}

/** Everything the parser reads. `RawMail` satisfies it structurally. */
export interface DeliveryReportSource {
  headerLines?: readonly RawMailHeaderLine[];
  contentType?: MailContentType | null;
  reportParts?: readonly MailPart[];
  text?: string | null;
}

/** One address a caller must act on, and the reason to record against it. */
export interface SuppressibleRecipient {
  address: string;
  reason: 'HARD_BOUNCE' | 'COMPLAINT';
  status: string | null;
  diagnostic: string | null;
}

const EMPTY: DeliveryReport = { kind: 'NONE', originalMessageId: null, recipients: [] };

/** `Feedback-Type` values that mean the recipient refused this mail. */
const COMPLAINT_TYPES = new Set(['abuse', 'fraud']);

export function parseDeliveryReport(source: DeliveryReportSource): DeliveryReport {
  const reportType = String(source?.contentType?.params?.['report-type'] ?? '').toLowerCase();
  const parts = source?.reportParts ?? [];

  const arf = partOf(parts, 'message/feedback-report');
  if (arf || reportType === 'feedback-report') return parseArf(arf, parts);

  const mdn = partOf(parts, 'message/disposition-notification');
  if (mdn || reportType === 'disposition-notification') return parseMdn(mdn, parts);

  const dsn = partOf(parts, 'message/delivery-status');
  if (dsn) return parseDsn(dsn, parts);

  // mailparser folds `message/delivery-status` into `text` under default
  // options, so a caller that did not ask for the part still has the fields —
  // just smeared into the human-readable body. Read them from there rather than
  // forcing every caller to re-parse the source.
  if (reportType === 'delivery-status' && source?.text) {
    const fromText = parseDsn(source.text, parts);
    if (fromText.recipients.length) return fromText;
  }

  // The NDRs that predate RFC 3464 carry no report part at all — just this
  // header and prose. It is the only handle they give.
  const failed = failedRecipientsHeader(source);
  if (failed.length) {
    return {
      kind: 'DSN',
      originalMessageId: originalMessageIdFrom(parts, null),
      recipients: failed.map((recipient) => ({
        recipient,
        // The header exists only on a permanent failure notice; there is no
        // transient form of it.
        outcome: 'HARD_BOUNCE' as DeliveryOutcome,
        status: null,
        action: 'failed',
        diagnostic: null,
      })),
    };
  }

  return EMPTY;
}

/** The addresses a caller must act on. Nothing transient, nothing unknown. */
export function suppressibleRecipients(report: DeliveryReport): SuppressibleRecipient[] {
  const seen = new Set<string>();
  const out: SuppressibleRecipient[] = [];
  for (const r of report?.recipients ?? []) {
    if (r.outcome !== 'HARD_BOUNCE' && r.outcome !== 'COMPLAINT') continue;
    if (seen.has(r.recipient)) continue;
    seen.add(r.recipient);
    out.push({ address: r.recipient, reason: r.outcome, status: r.status, diagnostic: r.diagnostic });
  }
  return out;
}

function parseDsn(text: string | null, parts: readonly MailPart[]): DeliveryReport {
  const blocks = fieldBlocks(text);
  if (!blocks.length) return EMPTY;

  // The per-message block is the first one that names no recipient.
  const perMessage = blocks.find((b) => !b['final-recipient'] && !b['original-recipient']) ?? {};
  const recipients: DeliveryReportRecipient[] = [];
  /** Per-recipient blocks whose recipient we could not read as an address. */
  const unnamed: Record<string, string>[] = [];
  for (const block of blocks) {
    // Prefer the address the SENDER used: an alias rewrite puts the internal
    // mailbox in Final-Recipient, and suppressing that helps nobody.
    const recipient = addressOf(block['original-recipient']) || addressOf(block['final-recipient']);
    if (!recipient) {
      // `Status` is a per-recipient field (RFC 3464 §2.3.4); the per-message
      // block never carries one.
      if (block['status'] !== undefined) unnamed.push(block);
      continue;
    }
    recipients.push(recipientOf(recipient, block));
  }

  // A per-recipient block MUST name its recipient, but the name is not always
  // one we can read: `rfc822; <>`, an X.400 address, a bare local alias. The
  // returned headers then are the only place the address is written. Taken
  // only when it is unambiguous — ONE unreadable block and ONE address in the
  // returned `To` — because guessing which of several people a status belongs
  // to is how the wrong customer gets suppressed. (This names a candidate, it
  // does not authorise one: `dsn-provenance.ts` still has to tie the address
  // to mail the workspace sent.)
  if (!recipients.length && unnamed.length === 1) {
    const returned = parseAddressList(headerFromReturnedMessage(parts, 'to'));
    if (returned.length === 1) recipients.push(recipientOf(returned[0].address, unnamed[0]));
  }
  if (!recipients.length) return EMPTY;
  return {
    kind: 'DSN',
    originalMessageId: originalMessageIdFrom(parts, perMessage['original-message-id']),
    recipients,
  };
}

/** One per-recipient block, read. */
function recipientOf(recipient: string, block: Record<string, string>): DeliveryReportRecipient {
  const action = lower(block['action']) || null;
  const diagnostic = block['diagnostic-code'] || null;
  const status = statusOf(block['status'], diagnostic);
  return { recipient, outcome: outcomeOf(status, action), status, action, diagnostic };
}

function parseArf(text: string | null, parts: readonly MailPart[]): DeliveryReport {
  const block = fieldBlocks(text)[0] ?? {};
  const feedbackType = lower(block['feedback-type']);
  // `not-spam` is a RETRACTION. Suppressing on one would be the exact opposite
  // of what the report says.
  const complaint = COMPLAINT_TYPES.has(feedbackType);
  const recipient =
    addressOf(block['original-rcpt-to']) ||
    addressOf(block['removal-recipient']) ||
    addressOf(headerFromReturnedMessage(parts, 'to'));
  const recipients: DeliveryReportRecipient[] = recipient
    ? [
        {
          recipient,
          outcome: complaint ? 'COMPLAINT' : 'UNKNOWN',
          status: null,
          action: null,
          diagnostic: null,
        },
      ]
    : [];
  return { kind: 'ARF', originalMessageId: originalMessageIdFrom(parts, block['original-message-id']), recipients };
}

function parseMdn(text: string | null, parts: readonly MailPart[]): DeliveryReport {
  const block = fieldBlocks(text)[0] ?? {};
  const recipient = addressOf(block['original-recipient']) || addressOf(block['final-recipient']);
  return {
    kind: 'MDN',
    originalMessageId: originalMessageIdFrom(parts, block['original-message-id']),
    recipients: recipient
      ? [
          {
            recipient,
            outcome: 'READ_RECEIPT',
            status: null,
            action: block['disposition'] ? String(block['disposition']) : null,
            diagnostic: null,
          },
        ]
      : [],
  };
}

/**
 * Split a report body into field blocks and unfold each one.
 *
 * RFC 3464 separates the per-message block from each per-recipient block with a
 * blank line, and folds a long value onto continuation lines that begin with
 * whitespace. Both matter: without the split, three recipients read as one;
 * without the unfold, a wrapped `Diagnostic-Code` loses the half that says why.
 */
function fieldBlocks(text: string | null | undefined): Record<string, string>[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const blocks: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let lastKey: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      if (current) blocks.push(current);
      current = null;
      lastKey = null;
      continue;
    }
    if (/^\s/.test(rawLine) && current && lastKey) {
      current[lastKey] = `${current[lastKey]} ${rawLine.trim()}`.trim();
      continue;
    }
    const colon = rawLine.indexOf(':');
    if (colon <= 0) continue;
    const key = rawLine.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(key)) continue;
    current = current ?? {};
    // First wins: a report that repeats a field is not a place to take the
    // later value on trust.
    if (!(key in current)) current[key] = rawLine.slice(colon + 1).trim();
    lastKey = key;
  }
  if (current) blocks.push(current);
  return blocks;
}

/** `rfc822; user@example.com` → the address, or '' when it is not one. */
function addressOf(field: string | null | undefined): string {
  if (typeof field !== 'string') return '';
  const semi = field.lastIndexOf(';');
  const raw = (semi >= 0 ? field.slice(semi + 1) : field).trim().replace(/^<|>$/g, '');
  const address = normalizeAddress(raw);
  // A DSN may name `<unknown>` or an X.400 address. Neither is something to
  // suppress, and neither is a lookup key worth carrying.
  return address && isSingleAddress(address) ? address : '';
}

/**
 * The enhanced status code, from the field or — when the server omitted it —
 * from the diagnostic it did send.
 *
 * The last tier is deliberately narrow: the SMTP reply code is only read where
 * it actually appears, at the head of the diagnostic (`smtp; 550 …`). Scanning
 * the whole sentence for a three-digit number turns "over its 500 MB quota"
 * into a permanent failure, and a wrongly suppressed address is a customer who
 * stops receiving mail with nobody the wiser. A bare `Action: failed` with no
 * code at all stays UNKNOWN for the same reason.
 */
function statusOf(status: string | null | undefined, diagnostic: string | null): string | null {
  const explicit = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(String(status ?? ''));
  if (explicit) return explicit[0];
  const enhanced = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(String(diagnostic ?? ''));
  if (enhanced) return enhanced[0];
  const reply = /^(?:[^;]*;\s*)?([245])\d{2}\b/.exec(String(diagnostic ?? '').trim());
  return reply ? `${reply[1]}.0.0` : null;
}

function outcomeOf(status: string | null, action: string | null): DeliveryOutcome {
  if (action === 'delivered' || action === 'relayed' || action === 'expanded') return 'DELIVERED';
  if (!status) return 'UNKNOWN';
  if (status.startsWith('5.')) return 'HARD_BOUNCE';
  if (status.startsWith('4.')) return 'SOFT_BOUNCE';
  if (status.startsWith('2.')) return 'DELIVERED';
  return 'UNKNOWN';
}

/**
 * Which mail this report is about.
 *
 * `Original-Message-ID` first, then the `Message-ID` of the returned headers
 * part — and null is a perfectly acceptable answer. Suppression works on the
 * address; the id only decides whether the bounce can also be stamped on the
 * campaign recipient row.
 */
function originalMessageIdFrom(parts: readonly MailPart[], field: string | null | undefined): string | null {
  return normalizeMessageId(field) ?? normalizeMessageId(headerFromReturnedMessage(parts, 'message-id'));
}

/** The text of the sub-part with this content type, or null. */
function partOf(parts: readonly MailPart[], contentType: string): string | null {
  const hit = (parts ?? []).find((p) => lower(p?.contentType).startsWith(contentType));
  return hit?.text ? hit.text : null;
}

/**
 * Read one header out of the headers a report returns (`text/rfc822-headers`,
 * or the head of a whole `message/rfc822`).
 *
 * Two details decide whether the bounce can be tied back to our mail at all:
 *
 * - **Unfolded first.** Plenty of MTAs fold a long id onto its own line —
 *   `Message-ID:` then ` <…@…>` — and reading only the first physical line
 *   returned an empty id, so a genuine bounce of our own mail could never be
 *   proved to be ours.
 * - **The head only.** A returned `message/rfc822` carries the original BODY
 *   too, and a `Message-ID:` or `To:` line typed into a body is not a header.
 */
function headerFromReturnedMessage(parts: readonly MailPart[], name: string): string | null {
  const part = (parts ?? []).find((p) => /rfc822/i.test(String(p?.contentType ?? '')));
  if (!part?.text) return null;
  const head = part.text.replace(/^(?:[ \t]*\r?\n)+/, '').split(/\r?\n[ \t]*\r?\n/)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}[ \\t]*:(.*)$`, 'im');
  const m = re.exec(unfolded);
  const value = m ? m[1].trim() : '';
  return value || null;
}

/** Every address named by `X-Failed-Recipients`, across repeats of the header. */
function failedRecipientsHeader(source: DeliveryReportSource): string[] {
  const values = headerLineValues({ headerLines: (source?.headerLines ?? []) as RawMailHeaderLine[] }, 'x-failed-recipients');
  const out: string[] = [];
  for (const value of values) {
    for (const piece of value.split(',')) {
      const address = addressOf(piece);
      if (address && !out.includes(address)) out.push(address);
    }
  }
  return out;
}

function lower(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
