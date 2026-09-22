import addressparser from 'nodemailer/lib/addressparser';
import { hasHeaderInjection, isSingleAddress, normalizeAddress } from '../../../../common/util/email-address';
import { normalizeMessageId } from '../email-message-id';

/**
 * ONE shape for an inbound mail, whatever door it came through.
 *
 * Four sources feed this pipeline — the IMAP poller, IMAP IDLE, the Sent-folder
 * reconciler and the inbound webhook — and until now each of them decided for
 * itself what "the sender" and "the recipient" meant. That is how two
 * cross-tenant bugs got in: `email.adapter.ts`'s first-`<>` regex let
 * `"<ceo@victim.com>" <attacker@evil.com>` attribute a mail to any address, and
 * the SAME regex picked the destination CHANNEL on the webhook, so a header a
 * sender fully controls decided which WORKSPACE received the mail
 * (`from-display-name-spoof`).
 *
 * So this file is not a bag of interfaces. It is the normalisation itself: the
 * types plus the small pure functions that build them. A type alone cannot make
 * four callers agree, and the shared helpers are exactly what the drift was.
 *
 * Three rules are baked in rather than documented:
 *
 * - **Structured identity.** `from` / `replyTo` / `to` are parsed mailboxes, and
 *   the display name is carried BESIDE the address, never re-parsed out of it.
 *   Passing a bare address instead is its own regression: `extractName` returns
 *   `''` for one, and every IMAP lead ends up named "Channel contact".
 * - **Route on what the server proved.** `envelopeTo` (the RCPT TO / provider
 *   envelope) is the routing key; the `To:` header is a fallback the sender
 *   wrote. `preferredRecipients()` encodes that order once.
 * - **`internalDate`, never the `Date:` header.** IMAP INTERNALDATE is the
 *   server's clock. The header is the sender's, and the age bound in
 *   `isTooOldToIngest` would otherwise be something an attacker (or a badly set
 *   laptop clock) could use to drop real mail.
 */

/** One parsed mailbox: the address, and the name as it was written. */
export interface MailAddress {
  /** Trimmed and lower-cased. Only ever a deliverable single address. */
  address: string;
  /** The display name verbatim — NEVER an address extracted out of it. */
  name: string;
}

/** Which door the item came through. Matches `EmailInboundItem.source`. */
export type InboundSource = 'imap' | 'imap-sent' | 'webhook' | 'gmail' | 'graph';

/** A raw header line in the order the message carried it (topmost first). */
export interface RawMailHeaderLine {
  /** Lower-cased header name. */
  key: string;
  /** The line as received, `Name: value`. */
  line: string;
}

/** A content type WITH its parameters — the params are the whole point here. */
export interface MailContentType {
  /** Lower-cased `type/subtype`. */
  value: string;
  /** Lower-cased keys, values verbatim. */
  params: Record<string, string>;
}

/** A sub-part this pipeline reads as text (delivery-status, ARF, MDN, headers). */
export interface MailPart {
  contentType: string;
  text: string;
}

/** What is attached, without the bytes — enough to describe, never to read. */
export interface RawAttachment {
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
}

/**
 * The ESP's own authentication verdict, for the webhook path where there is no
 * `Authentication-Results` line because the ESP is the MX.
 * Mailgun posts `X-Mailgun-Spf` / `X-Mailgun-Dkim-Check-Result`; SendGrid posts
 * `SPF` and a `dkim` map.
 */
export interface ProviderAuth {
  spf?: string | null;
  dkim?: string | null;
  dmarc?: string | null;
}

/** What every inbound path normalises to before a single decision is made. */
export interface RawMail {
  source: InboundSource;
  /** `uidValidity:uid`, a provider event id — whatever identifies it at source. */
  itemKey: string;
  /** Every mailbox of the From header. A multi-mailbox From is RFC-legal and
   *  rejecting it would drop real customer mail; the FIRST one is the identity. */
  from: MailAddress[];
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** RCPT TO / the provider's envelope. What the SERVER can prove. */
  envelopeTo: string[];
  subject: string | null;
  /** Normalised: no brackets, lower-cased domain (`normalizeMessageId`). */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Ordered and raw. `Authentication-Results` MUST be read from here. */
  headerLines: RawMailHeaderLine[];
  contentType: MailContentType | null;
  /**
   * mailparser folds every RFC 2369 `List-*` header into one `list` key, so the
   * IMAP caller can only answer `headers.has('list')`. It sets this hint;
   * classification ORs it with its own scan of `headerLines`, so neither path
   * can lose mailing-list filtering.
   */
  hasListHeaders: boolean;
  /** IMAP INTERNALDATE / the provider's receive time. NEVER the `Date:` header. */
  internalDate: Date | null;
  sizeBytes: number | null;
  text: string | null;
  html: string | null;
  /** A provider-stripped body (Mailgun `stripped-text`), when one was posted. */
  strippedText: string | null;
  attachments: RawAttachment[];
  /** delivery-status / feedback-report / disposition-notification / rfc822-headers. */
  reportParts: MailPart[];
  providerAuth: ProviderAuth | null;
  /** The body was fetched under a byte cap and may be cut short. */
  bodyTruncated: boolean;
}

/** `EmailInboundItem.state`. */
export type InboundItemState = 'NEW' | 'DONE' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';

/**
 * `EmailInboundItem.reason` — the answer to "where did my customer's mail go?".
 * A code, never a sentence: the UI localises it, the log prints the detail.
 */
export type InboundSkipReason =
  | 'auto-reply'
  | 'dsn'
  | 'mdn'
  | 'mailing-list'
  | 'own-echo'
  | 'platform-own'
  | 'daemon'
  | 'no-sender'
  | 'oversize-truncated'
  | 'too-old'
  | 'empty-body'
  | 'parse-failed'
  | 'policy-not-a-lead';

/** Human, machine, or a report. */
export type MailKind =
  | 'HUMAN'
  | 'AUTO_REPLY'
  /** Goes to the delivery-report lane: an RFC 3464 DSN or an ARF complaint. */
  | 'BOUNCE_DSN'
  | 'MDN'
  | 'LIST'
  | 'OWN_ECHO'
  | 'PLATFORM_OWN'
  | 'DAEMON';

/** Three states, and `unknown` is the one that changes nothing (§A4.3). */
export type AuthVerdict = 'pass' | 'fail' | 'unknown';

/** What the pipeline decided to do with one item, and why. */
export interface InboundDecision {
  /** INGEST: it is a message. DELIVERY_REPORT: the bounce lane. SKIP: recorded, not ingested. */
  disposition: 'INGEST' | 'SKIP' | 'DELIVERY_REPORT';
  kind: MailKind;
  /** The ledger code. Null only when the item is ingested as a message. */
  reason: InboundSkipReason | null;
  /** The sentence for the debug log; never shown to a tenant raw. */
  detail: string | null;
  /**
   * `false` suppresses the AI reply, the LeadCreated fan-out and tool use, and
   * renders an "unverified sender" badge — but the mail is STILL ingested.
   * Silence is the failure mode being removed, not added to.
   */
  senderVerified: boolean;
}

/** Above this, the body is fetched selectively rather than pulled whole. */
export const MAX_SOURCE_BYTES = 1_000_000;

/** The cap on a single selective body download (decoded). */
export const MAX_BODY_DOWNLOAD_BYTES = 256 * 1024;

/**
 * How old a mail may be and still be ingested when RESUMING a cursor.
 *
 * Generous on purpose. A tighter "since the last poll" bound is a mail-loss
 * bug: after a weekend outage, a deploy or a channel that failed its health
 * check for days, every genuine reply that arrived in the gap would be skipped
 * and the cursor would advance past it. A month still blocks the
 * un-archive-300-mails scenario and cannot eat a real reply.
 */
export const MAX_INGEST_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Every RFC 2369 list header, so a raw-line scan matches the mailparser fold. */
const LIST_HEADER_RE = /^list-(id|unsubscribe|unsubscribe-post|help|post|owner|archive|subscribe)$/;

/**
 * Parse an address header into mailboxes.
 *
 * The forged-display-name case is the reason this exists: addressparser reads
 * `"<ceo@victim.com>" <attacker@evil.com>` as one mailbox whose NAME is the
 * decoration, where the old first-`<>` regex answered the victim's address.
 * Groups are flattened (`Team:a@x,b@x;`) and the empty group form
 * (`undisclosed-recipients:;`) yields nothing at all.
 */
export function parseAddressList(raw: string | null | undefined): MailAddress[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  // RFC 5322 folding is legitimate — a long From runs onto a continuation line
  // that begins with whitespace — so unfold it before judging. What is left
  // after that is a break somebody WROTE into the value, which is an injection
  // attempt and not an address list: refuse the whole value rather than
  // parsing around it and keeping half.
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  if (hasHeaderInjection(unfolded)) return [];
  let entries: { address?: string; name?: string }[];
  try {
    entries = addressparser(unfolded, { flatten: true }) as { address?: string; name?: string }[];
  } catch {
    return [];
  }
  const out: MailAddress[] = [];
  for (const entry of entries ?? []) {
    const address = normalizeAddress(entry?.address);
    if (!address || !isSingleAddress(address)) continue;
    out.push({ address, name: String(entry?.name ?? '').trim() });
  }
  return out;
}

/**
 * Accept whatever the caller already holds: mailparser's `AddressObject`, the
 * array form it uses when a header appears twice, or a raw string.
 */
export function toAddressList(value: unknown): MailAddress[] {
  if (value == null) return [];
  if (typeof value === 'string') return parseAddressList(value);
  if (Array.isArray(value)) return value.flatMap((v) => toAddressList(v));
  const obj = value as { value?: unknown; text?: unknown; address?: unknown; name?: unknown };
  if (Array.isArray(obj.value)) {
    const out: MailAddress[] = [];
    for (const entry of obj.value as { address?: string; name?: string; group?: unknown }[]) {
      if (Array.isArray(entry?.group)) {
        out.push(...toAddressList(entry.group));
        continue;
      }
      const address = normalizeAddress(entry?.address);
      if (!address || !isSingleAddress(address)) continue;
      out.push({ address, name: String(entry?.name ?? '').trim() });
    }
    return out;
  }
  if (typeof obj.address === 'string') {
    const address = normalizeAddress(obj.address);
    return address && isSingleAddress(address) ? [{ address, name: String(obj.name ?? '').trim() }] : [];
  }
  if (typeof obj.text === 'string') return parseAddressList(obj.text);
  return [];
}

/** The identity of a mailbox list: the first deliverable address, or ''. */
export function primaryAddress(list: readonly MailAddress[] | null | undefined): string {
  return list?.[0]?.address ?? '';
}

/** The display name that goes with `primaryAddress`, or ''. */
export function primaryName(list: readonly MailAddress[] | null | undefined): string {
  return list?.[0]?.name ?? '';
}

/**
 * The FIRST occurrence of a header, as a raw string.
 *
 * "First" is a security property, not a convenience: a border MTA PREPENDS the
 * result it vouches for, so the topmost line is the trusted one. Merging
 * repeated headers — which `headers.get()` does — is how an attacker-injected
 * duplicate gets a say.
 */
export function headerLineValue(mail: Pick<RawMail, 'headerLines'>, name: string): string | null {
  const key = String(name ?? '').toLowerCase();
  for (const h of mail?.headerLines ?? []) {
    if (h?.key === key) return valueOf(h.line);
  }
  return null;
}

/** Every occurrence, for the callers that legitimately want them all. */
export function headerLineValues(mail: Pick<RawMail, 'headerLines'>, name: string): string[] {
  const key = String(name ?? '').toLowerCase();
  const out: string[] = [];
  for (const h of mail?.headerLines ?? []) {
    if (h?.key === key) out.push(valueOf(h.line));
  }
  return out;
}

/** Is this header present at all (value irrelevant)? */
export function hasHeaderLine(mail: Pick<RawMail, 'headerLines'>, name: string): boolean {
  const key = String(name ?? '').toLowerCase();
  return (mail?.headerLines ?? []).some((h) => h?.key === key);
}

/** Does this mail carry any RFC 2369 `List-*` header, by line or by hint? */
export function hasListHeader(mail: Pick<RawMail, 'headerLines' | 'hasListHeaders'>): boolean {
  if (mail?.hasListHeaders) return true;
  return (mail?.headerLines ?? []).some((h) => LIST_HEADER_RE.test(String(h?.key ?? '')));
}

/** `Name: value` → `value`. A line with no colon is its own value. */
function valueOf(line: string): string {
  const raw = String(line ?? '');
  const colon = raw.indexOf(':');
  return (colon >= 0 ? raw.slice(colon + 1) : raw).trim();
}

/**
 * A content type WITH its parameters.
 *
 * The old local `header()` helper did `String(v.value ?? v)`, which yields bare
 * `multipart/report` and drops `report-type=delivery-status` — the one
 * parameter that says whether this mail is a bounce, a read receipt or an abuse
 * complaint (`dsn-in-mailbox`).
 */
export function parseContentType(raw: string | null | undefined): MailContentType | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(';');
  const value = String(parts.shift() ?? '').trim().toLowerCase();
  if (!value) return null;
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    params[key] = part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return { value, params };
}

/**
 * Who this mail was addressed to, in the order routing may trust it.
 *
 * The envelope first, always: it is what the receiving server accepted the mail
 * for, and a sender cannot forge it into another tenant's mailbox. The `To:`
 * and `Cc:` headers come last and only when there is no envelope at all.
 */
export function preferredRecipients(mail: Pick<RawMail, 'envelopeTo' | 'to' | 'cc'>): string[] {
  const envelope = (mail?.envelopeTo ?? [])
    .map((v) => normalizeAddress(v))
    .filter((v) => v && isSingleAddress(v)) as string[];
  if (envelope.length) return unique(envelope);
  const headers = [...(mail?.to ?? []), ...(mail?.cc ?? [])].map((a) => a?.address).filter(Boolean);
  return unique(headers);
}

/** Is this mail too big to pull whole? Unknown size is never a reason to drop. */
export function isOversize(sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > MAX_SOURCE_BYTES;
}

/**
 * Is this mail old enough to be somebody's archive rather than a new reply?
 *
 * Only ever asked on the RESUME path. A first run is already bounded by the
 * `since` search, and bounding it twice would drop the backlog a mailbox is
 * connected in order to read. A missing or unparseable date ingests — fail
 * open, because a dropped mail is silent and an old one is merely noise.
 */
export function isTooOldToIngest(
  internalDate: Date | string | null | undefined,
  opts: { resuming: boolean; now?: number },
): boolean {
  if (!opts?.resuming) return false;
  const at = internalDate instanceof Date ? internalDate : internalDate ? new Date(internalDate) : null;
  const ms = at ? at.getTime() : NaN;
  if (!Number.isFinite(ms)) return false;
  return (opts.now ?? Date.now()) - ms > MAX_INGEST_AGE_MS;
}

/**
 * The body for a mail that carried nothing but attachments.
 *
 * It says the content was NOT read, in so many words. The AI answers whatever
 * is ingested, so an empty message ("the customer said nothing") and a
 * confident summary ("they sent the contract") are both wrong; naming the files
 * and admitting the rest is the only honest option. Returning `false` from the
 * ingest instead is what this replaces — that dropped the mail entirely.
 */
export function synthesizeAttachmentBody(attachments: readonly RawAttachment[] | null | undefined): string | null {
  const names = (attachments ?? []).map((a) => String(a?.filename ?? '').trim() || '(adsız dosya)');
  if (!names.length) return null;
  return `[${names.length} dosya eklendi: ${names.join(', ')} — içerik okunamadı]`;
}

/**
 * Build a `RawMail`, filling every field.
 *
 * The builder exists so the poller, IDLE, the Sent reconciler and the webhook
 * cannot each leave a different field undefined — a classifier that has to
 * guard every property is a classifier that will one day guard the wrong one.
 */
export function rawMail(
  partial: Partial<RawMail> & Pick<RawMail, 'source' | 'itemKey'>,
): RawMail {
  return {
    source: partial.source,
    itemKey: String(partial.itemKey ?? ''),
    from: partial.from ?? [],
    replyTo: partial.replyTo ?? [],
    to: partial.to ?? [],
    cc: partial.cc ?? [],
    envelopeTo: partial.envelopeTo ?? [],
    subject: partial.subject ?? null,
    // Normalised HERE so no caller can persist a bracketed spelling that the
    // other side's lookup will never match.
    messageId: normalizeMessageId(partial.messageId),
    inReplyTo: normalizeMessageId(partial.inReplyTo),
    references: messageIdList(partial.references),
    headerLines: partial.headerLines ?? [],
    contentType: partial.contentType ?? null,
    hasListHeaders: partial.hasListHeaders ?? false,
    internalDate: partial.internalDate ?? null,
    sizeBytes: partial.sizeBytes ?? null,
    text: partial.text ?? null,
    html: partial.html ?? null,
    strippedText: partial.strippedText ?? null,
    attachments: partial.attachments ?? [],
    reportParts: partial.reportParts ?? [],
    providerAuth: partial.providerAuth ?? null,
    bodyTruncated: partial.bodyTruncated ?? false,
  };
}

/**
 * The mailparser surface this module reads.
 *
 * Structural rather than `import { ParsedMail }`: the webhook path has no
 * mailparser object to hand, and describing only what is read keeps the two
 * callers honest about how little of it matters.
 */
export interface ParsedMailLike {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  replyTo?: unknown;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  headerLines?: readonly { key?: string; line?: string }[];
  headers?: { get?(name: string): unknown; has?(name: string): boolean };
  text?: string;
  html?: string | false;
  attachments?: readonly { filename?: string; contentType?: string; size?: number; content?: unknown }[];
}

/** Everything the SERVER knows that the message itself cannot tell us. */
export interface ParsedMailEnvelope {
  source: InboundSource;
  itemKey: string;
  /** IMAP INTERNALDATE / the provider's receive time. NOT `parsed.date`. */
  internalDate?: Date | null;
  /** IMAP RFC822.SIZE, known before anything is downloaded. */
  sizeBytes?: number | null;
  /** RCPT TO, when the source exposes it. */
  envelopeTo?: string[];
  bodyTruncated?: boolean;
}

/**
 * Report sub-parts are carried as text, so `parseDeliveryReport` needs no MIME.
 *
 * `text/rfc822-headers` and a whole `message/rfc822` are in here for one
 * reason: Postfix — the commonest DSN sender there is — returns the bounced
 * message's headers as `text/rfc822-headers`, and other MTAs return the whole
 * message. Both carry the `Message-ID` that `originalMessageIdFrom` falls back
 * to when a DSN omits `Original-Message-ID`, which is most of them; without
 * these two spellings mailparser files the returned copy under `attachments`
 * and the bounce can never be stamped on the recipient row that earned it.
 */
const REPORT_PART_RE =
  /^(?:message\/(?:delivery-status|feedback-report|disposition-notification|rfc822(?:-headers)?)|text\/rfc822-headers)/i;

/**
 * A returned message is the only report part that can be MEGABYTES — it is the
 * bounced mail, attachments and all. Only its head is wanted (that is where
 * the headers are), and carrying the rest would put a customer's attachment
 * through a JSON column.
 */
const RETURNED_MESSAGE_RE = /^(?:text|message)\/rfc822(?:-headers)?/i;
const RETURNED_HEAD_BYTES = 16 * 1024;

/**
 * Normalise what mailparser produced into the one shape.
 *
 * This is the convergence point, and three of its lines are the whole reason
 * it is not left to each caller:
 *
 * - **`internalDate` comes from the envelope, never from `parsed.date`.** The
 *   `Date:` header is written by the sender; bounding ingest age on it lets a
 *   skewed clock — or an attacker — have real mail dropped.
 * - **`hasListHeaders` asks `headers.has()` for BOTH `list` and
 *   `list-unsubscribe`.** mailparser folds every RFC 2369 `List-*` header into
 *   one `list` key, so a raw-line scan alone would silently stop filtering
 *   mailing lists on the one path that filters them correctly today.
 * - **the content type keeps its params.** `headers.get('content-type')`
 *   returns `{value, params}`; stringifying it drops `report-type`, which is
 *   the difference between a bounce, a read receipt and a customer's mail.
 */
export function rawMailFromParsed(parsed: ParsedMailLike, envelope: ParsedMailEnvelope): RawMail {
  const p = parsed ?? {};
  const headerLines: RawMailHeaderLine[] = (p.headerLines ?? [])
    .filter((h) => h && typeof h.line === 'string')
    .map((h) => ({ key: String(h.key ?? '').toLowerCase(), line: String(h.line) }));

  const reportParts: MailPart[] = [];
  const attachments: RawAttachment[] = [];
  for (const a of p.attachments ?? []) {
    const contentType = String(a?.contentType ?? '');
    if (REPORT_PART_RE.test(contentType)) {
      const text = contentOf(a?.content);
      reportParts.push({
        contentType,
        text: RETURNED_MESSAGE_RE.test(contentType) ? text.slice(0, RETURNED_HEAD_BYTES) : text,
      });
      continue;
    }
    attachments.push({
      filename: a?.filename ? String(a.filename) : null,
      contentType: contentType || null,
      sizeBytes: typeof a?.size === 'number' ? a.size : null,
    });
  }

  return rawMail({
    source: envelope.source,
    itemKey: envelope.itemKey,
    from: toAddressList(p.from),
    replyTo: toAddressList(p.replyTo),
    to: toAddressList(p.to),
    cc: toAddressList(p.cc),
    envelopeTo: envelope.envelopeTo ?? [],
    subject: typeof p.subject === 'string' ? p.subject : null,
    messageId: p.messageId ?? null,
    inReplyTo: p.inReplyTo ?? null,
    references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
    headerLines,
    contentType: contentTypeOf(p),
    hasListHeaders: Boolean(p.headers?.has?.('list') || p.headers?.has?.('list-unsubscribe')),
    internalDate: envelope.internalDate ?? null,
    sizeBytes: envelope.sizeBytes ?? null,
    text: typeof p.text === 'string' ? p.text : null,
    html: typeof p.html === 'string' ? p.html : null,
    attachments,
    reportParts,
    bodyTruncated: envelope.bodyTruncated ?? false,
  });
}

/** mailparser hands back `{value, params}`; anything else is parsed as a string. */
function contentTypeOf(parsed: ParsedMailLike): MailContentType | null {
  const raw = parsed?.headers?.get?.('content-type');
  if (!raw) return null;
  if (typeof raw === 'string') return parseContentType(raw);
  const structured = raw as { value?: unknown; params?: Record<string, unknown> };
  if (typeof structured.value !== 'string') return null;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(structured.params ?? {})) {
    params[String(key).toLowerCase()] = String(value);
  }
  return { value: structured.value.toLowerCase(), params };
}

function contentOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof (content as Buffer).toString === 'function') return (content as Buffer).toString('utf8');
  return '';
}

/**
 * Every id in a `References` chain, normalised and de-duplicated.
 *
 * One header legitimately holds the whole chain (`<a@x> <b@x> <c@x>`), and
 * mailparser hands that over as a single string as often as it hands over an
 * array. Taking only the first bracketed value would leave threading with one
 * ancestor instead of the chain, which is the difference between joining the
 * right conversation and opening a new one.
 */
function messageIdList(value: readonly string[] | string | null | undefined): string[] {
  const entries = Array.isArray(value) ? value : value ? [value as string] : [];
  const out: string[] = [];
  for (const entry of entries) {
    const raw = String(entry ?? '');
    for (const piece of raw.match(/<[^<>]+>/g) ?? raw.split(/\s+/)) {
      const id = normalizeMessageId(piece);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
