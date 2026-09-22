import {
  InboundSkipReason,
  MailKind,
  RawMail,
  hasHeaderLine,
  hasListHeader,
  headerLineValue,
  primaryAddress,
} from './inbound-mail.types';

/**
 * Is this a person writing to us, or machinery?
 *
 * ## Why it is pure, and why it is shared
 *
 * These rules were `EmailImapPollService.skipReason` — correct, hard-won (two
 * of them were written after a live run tripped over senders no header rule
 * would have caught), and reachable from exactly one code path. The webhook
 * ingested bounces, read receipts and vacation auto-replies as customer text
 * the whole time, because nothing over there had ever heard of them.
 *
 * So the rules are lifted VERBATIM and given one home that needs no mailbox to
 * test. The caller supplies a `RawMail`; a webhook with no header map at all
 * still gets every sender-based rule, which is most of them.
 *
 * ## The reason is returned, not a boolean
 *
 * The first live run tripped over two senders no header-based rule would have
 * caught, and a bare "skipped" would not have told anyone why. Now there are
 * two answers rather than one: a `reason` CODE that goes in the
 * `EmailInboundItem` ledger (and answers "where did my customer's mail go?"),
 * and a `detail` sentence for the debug log.
 *
 * ## Order is load-bearing
 *
 * A DSN routinely carries `Auto-Submitted: auto-replied` as well, so the
 * report check runs FIRST — otherwise every bounce classifies as an auto-reply
 * and the delivery-report lane never sees it. The echo check runs before the
 * daemon rules, so a workspace whose own address is `no-reply@` reads its own
 * mail back as an echo rather than as somebody else's machinery.
 */

/** What the classifier concluded. */
export interface MailClassification {
  kind: MailKind;
  /** The ledger code. `null` only for HUMAN. */
  reason: InboundSkipReason | null;
  /** The rule that fired, for the debug log. `null` for HUMAN. */
  detail: string | null;
}

export interface ClassifyOptions {
  /** This deployment's own From (`EMAIL_FROM` / `EMAIL_USER`). */
  platformFrom?: string | null;
  /** The mailbox's own addresses — fromEmail, smtpUser, the channel externalId. */
  ownAddresses?: readonly string[] | null;
}

/**
 * Local parts that do not accept a reply, so mail from one is not the opening
 * of a conversation. Two groups: delivery machinery, and the unattended
 * addresses products send their notifications from.
 *
 * `notifications@` is the judgement call here and it is deliberate. Someone may
 * genuinely own such an address, but nobody holds a conversation with one — and
 * the cost of being wrong is asymmetric. Letting one through creates a lead,
 * opens a thread and points the auto-reply engine at a mailbox that will never
 * answer; keeping one out costs a line in a debug log.
 *
 * EXACT matches, deliberately. Prefix-matching this set would swallow
 * `notification-team@acme.com`, which may well be a person.
 */
export const DAEMON_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
]);

/**
 * VERP and per-message bounce addresses, which an exact-match set can never
 * cover: `bounces+abc123@`, `bounce-42-user=acme.com@`, `mailer-daemon-xyz@`
 * and the Exchange NDR mailbox. A separator is required after `bounce`, so a
 * person at `bouncer@` is still a person.
 */
const DAEMON_PATTERNS: readonly RegExp[] = [
  /^(bounce|bounces)[-+._]/,
  /^mailer-daemon\b/,
  /^mailer-daemon[-+._]/,
  /^microsoftexchange[0-9a-f]{32}$/,
];

/** RFC 3464 / ARF / MDN, by the `report-type` parameter of the content type. */
const REPORT_KINDS: Record<string, { kind: MailKind; reason: InboundSkipReason }> = {
  'delivery-status': { kind: 'BOUNCE_DSN', reason: 'dsn' },
  'feedback-report': { kind: 'BOUNCE_DSN', reason: 'dsn' },
  'disposition-notification': { kind: 'MDN', reason: 'mdn' },
};

const HUMAN: MailClassification = { kind: 'HUMAN', reason: null, detail: null };

export function classifyMail(mail: RawMail, opts: ClassifyOptions = {}): MailClassification {
  // 1. Reports first. A DSN carries Auto-Submitted too, and whichever of the
  //    two fires decides whether the bounce lane ever sees this mail.
  const reportType = mail?.contentType?.params?.['report-type'];
  if (mail?.contentType?.value === 'multipart/report' && reportType) {
    const hit = REPORT_KINDS[String(reportType).toLowerCase()];
    if (hit) return { kind: hit.kind, reason: hit.reason, detail: `multipart/report; report-type=${reportType}` };
  }
  // The NDRs that predate RFC 3464 are ordinary mail with this one header.
  if (hasHeaderLine(mail, 'x-failed-recipients')) {
    return { kind: 'BOUNCE_DSN', reason: 'dsn', detail: 'X-Failed-Recipients' };
  }

  // 2. RFC 3834: anything but "no" means the message was generated, not typed.
  const autoSubmitted = lower(headerLineValue(mail, 'auto-submitted'));
  if (autoSubmitted && autoSubmitted !== 'no') {
    return { kind: 'AUTO_REPLY', reason: 'auto-reply', detail: `Auto-Submitted: ${autoSubmitted}` };
  }

  const precedence = lower(headerLineValue(mail, 'precedence'));
  if (/\b(bulk|list|junk|auto_reply)\b/.test(precedence)) {
    const kind: MailKind = precedence.includes('auto_reply') ? 'AUTO_REPLY' : 'LIST';
    const reason: InboundSkipReason = kind === 'AUTO_REPLY' ? 'auto-reply' : 'mailing-list';
    return { kind, reason, detail: `bulk Precedence: ${precedence}` };
  }

  // NOT 'list-unsubscribe' alone: mailparser folds every RFC 2369 List-* header
  // into one structured `list` key, so asking for the raw name always answers
  // false on that path. `hasListHeader` checks the builder's fold hint AND the
  // raw lines, because the fold is the parser's behaviour, not the format's.
  if (hasListHeader(mail)) return { kind: 'LIST', reason: 'mailing-list', detail: 'mailing-list headers' };

  if (headerLineValue(mail, 'x-autoreply') || headerLineValue(mail, 'x-autorespond')) {
    return { kind: 'AUTO_REPLY', reason: 'auto-reply', detail: 'auto-responder header' };
  }

  // 3. Then the sender. Everything below here works with no headers at all,
  //    which is the shape the webhook path usually arrives in.
  const from = primaryAddress(mail?.from);
  if (!from) return { kind: 'DAEMON', reason: 'no-sender', detail: 'no sender address' };

  // Our OWN mailbox reading its own mail back. Checked before the daemon rules
  // so a workspace sending as `no-reply@` sees an echo, not a stranger's robot.
  const own = new Set((opts.ownAddresses ?? []).map((a) => lower(a)).filter(Boolean));
  if (own.has(from)) return { kind: 'OWN_ECHO', reason: 'own-echo', detail: `own address (${from})` };

  /**
   * OUR OWN product mail. The daily digest is addressed to the workspace owner
   * and leaves from the platform's `EMAIL_FROM`, so it lands in the very
   * mailbox this pipeline reads — and on the first live run it became a lead
   * named after the platform, with the digest as its opening message. No header
   * would have caught it: the digest is a perfectly ordinary person-shaped
   * email, and the only thing wrong with it is who sent it.
   */
  const platform = lower(opts.platformFrom);
  if (platform && from === platform) {
    return { kind: 'PLATFORM_OWN', reason: 'platform-own', detail: 'the platform own notification mail' };
  }

  const local = from.split('@')[0] ?? '';
  if (DAEMON_LOCAL_PARTS.has(local)) {
    return { kind: 'DAEMON', reason: 'daemon', detail: `unattended sender (${local}@)` };
  }
  if (DAEMON_PATTERNS.some((re) => re.test(local))) {
    return { kind: 'DAEMON', reason: 'daemon', detail: `bounce-return sender (${local}@)` };
  }

  return HUMAN;
}

/** Is this address one of the delivery-machinery shapes? Exported for the
 *  Sent-folder reconciler, which needs the same answer about a RECIPIENT. */
export function isDaemonSender(address: string | null | undefined): boolean {
  const local = lower(address).split('@')[0] ?? '';
  if (!local) return false;
  return DAEMON_LOCAL_PARTS.has(local) || DAEMON_PATTERNS.some((re) => re.test(local));
}

function lower(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
