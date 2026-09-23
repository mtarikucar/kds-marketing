import { normalizeAddress } from '../../../../common/util/email-address';
import { DeliveryReport, SuppressibleRecipient } from './delivery-report';

/**
 * Is this delivery report about mail we actually sent?
 *
 * ## Why this exists
 *
 * Nothing about a bounce is authenticated. `classifyMail` decides `BOUNCE_DSN`
 * purely from content the SENDER writes — a `multipart/report` structure, or a
 * bare `X-Failed-Recipients:` header — and both doors that read one (the IMAP
 * poller on the tenant's own mailbox, and the inbound webhook) then hand the
 * named addresses straight to `SuppressionService`, which writes a
 * `ContactSuppression` row and stamps `emailBouncedAt` on every matching lead.
 *
 * A tenant's mailbox address is on their website. Without this check, one
 * ordinary email to it — correctly SPF/DKIM/DMARC-signed, from the sender's own
 * domain, carrying one extra header — permanently stops that workspace mailing
 * anybody the sender names: quotes, invoices, booking confirmations, campaigns.
 * Silently, and with a ledger row that says the address hard-bounced.
 *
 * ## Why sender authentication is NOT the check
 *
 * `assessAuth` returns `fail` only on an explicit DMARC fail, or SPF and DKIM
 * failing together. The attacker does not need to forge anybody: they send from
 * their own domain, properly aligned, and the verdict is `pass`. Authentication
 * answers "is this sender who they claim to be", which was never the question.
 * The question is "is this report about OUR mail", and only provenance answers
 * that.
 *
 * ## Why the report's own shape is not the check either
 *
 * A `message/delivery-status` part with `Status: 5.1.1` is plain MIME text
 * anyone can type. Requiring the well-formed structure and demoting only the
 * legacy header shape moves the attack one line sideways.
 *
 * ## What is actually checked
 *
 * A record, in THIS workspace, of mail sent to THIS recipient. First a
 * `MailLog` row:
 *
 * - matched by the report's id (`Original-Message-ID`, else the `Message-ID`
 *   of the headers it returns). The ids are UUID-seeded
 *   (`email-message-id.ts`), so they cannot be guessed — but they CAN be known
 *   by anyone who received mail from the tenant, which is why the row's
 *   recipient must match the reported one too. Knowing a Message-ID must not
 *   become a licence to suppress a third party.
 * - otherwise by address, over a bounded window. `Original-Message-ID` is
 *   genuinely often absent (delivery-report.ts says so), and refusing every
 *   report without one would throw away the feature's whole reason for
 *   existing: the typo'd address we really did mail.
 *
 * Then, failing that, an OUTBOUND `Message` in this address's own email thread
 * that really left. Two writers put one there, and neither writes `MailLog`:
 *
 * - the conversational lane (`message-sender.service.ts` — the Inbox composer,
 *   the AI reply engine, a workflow's reply), which settles its row `SENT`
 *   with the Message-ID it put on the wire;
 * - the Sent-folder reconciler (`email-sent-poll.service.ts`), which files the
 *   mail the owner typed in Outlook or on a phone as an OUTBOUND echo.
 *
 * Same two halves, same pairing: by id to that message's own recipient, or by
 * address inside the window. See "The rule, lane by lane" for why this one is
 * sound.
 *
 * ## The rule, lane by lane
 *
 * Three doors read delivery reports, and the question is the same at each:
 * "did we send mail to the address this report names?" What differs is what
 * each door can SEE, and so what it can use as proof.
 *
 * - **The platform mailbox** (`platform-bounce-poll.service.ts`) is the
 *   publicly known `From` of every platform mail and has no workspace of its
 *   own. It keeps its own, stricter gate: the report's id must resolve to one
 *   `MailLog` row, the address must be that row's recipient, and the row's
 *   workspace is the only one written to. No id, no write — it cannot scope an
 *   address-level match to a tenant, so it does not try.
 * - **The tenant's own mailbox** (the IMAP poller, and the tokenized relay
 *   webhook) has a workspace, so it may also match by address over a window,
 *   and it may use the workspace's conversation ledger: the replies the product
 *   sent from this mailbox, and what only that mailbox can produce — the mail
 *   its owner sent, as the Sent-folder reconciler read it back. Nobody outside
 *   can write into a tenant's Sent folder, which is what makes that proof and
 *   not just another header. (The same residual as the `MailLog` window
 *   applies: someone who gets the workspace to MAIL an address — by writing in
 *   as it so the AI answers — can then bounce it inside the window.)
 *
 * What the tenant lane may NOT treat as proof, and why each was rejected:
 *
 * - **The mailbox itself.** The IMAP login authenticates US reading the box;
 *   it says nothing about who wrote what is in it. The tenant's address is on
 *   their website — it is exactly as open to strangers as the platform's.
 * - **"The address is one of our leads."** That is the list an attacker most
 *   wants to hit — quotes, invoices, bookings go to leads — and research
 *   imports fill it with public addresses anybody can guess. A lead record
 *   says the workspace KNOWS a person, not that it mailed them. The cost of
 *   refusing the rare genuine bounce with no evidence at all (the owner mailed
 *   a lead from Outlook with Sent reading switched off) is ONE more bounce: the
 *   next product send carries our id, its DSN resolves, and the address is
 *   suppressed then — with proof.
 * - **The returned headers alone.** `From: <our mailbox>` / `To: <victim>` in
 *   a `text/rfc822-headers` part is typed by whoever sends the report. The
 *   returned headers are used for what they POINT AT — the id that has to
 *   resolve to our own row, and (when the report names nobody readable) the
 *   candidate address — never as evidence on their own.
 * - **The reporter's domain.** `MAILER-DAEMON@<the recipient's domain>` is free
 *   text; without a DMARC-aligned pass it is forged in one line, and genuine
 *   bounces mostly come from the SENDER's provider anyway.
 *
 * ## What is deliberately NOT solved here
 *
 * Someone who KNOWS the tenant mails a given customer can still get that
 * customer suppressed. That residual is capped rather than closed: one inbound
 * message may suppress at most `MAX_SUPPRESSIONS_PER_REPORT` addresses, and
 * everything refused is returned so the caller can record it. A wrong
 * suppression has to be diagnosable, because silence is what makes this
 * expensive — not the write itself.
 */

/**
 * How far back a report may reach when it names no message id.
 *
 * Long enough for a real retry queue to give up (a receiving MTA may hold a
 * message for days before the final NDR) and short enough that an address the
 * workspace mailed once, years ago, is not a standing suppression target.
 */
export const PROVENANCE_WINDOW_DAYS = 30;

/**
 * The most addresses one inbound message may suppress.
 *
 * A genuine DSN names one recipient, rarely a handful; RFC 3464 allows several
 * because one outgoing message can have several envelope recipients, and this
 * product sends one recipient per message. A list of forty is a batch weapon,
 * not a bounce.
 */
export const MAX_SUPPRESSIONS_PER_REPORT = 10;

/**
 * The slice of Prisma this needs — narrow, so tests hand it a plain object.
 *
 * The conversation ledger is optional: a caller that hands over only
 * `mailLog` still gets every `MailLog` proof, and simply cannot use the
 * Sent-folder one.
 */
export interface MailLogLookup {
  mailLog: { findFirst: (args: any) => Promise<{ id: string } | null> };
  contactIdentity?: { findMany: (args: any) => Promise<Array<{ id: string }>> };
  conversation?: { findMany: (args: any) => Promise<Array<{ id: string }>> };
  message?: { findFirst: (args: any) => Promise<{ id: string } | null> };
}

/** The `Message.status` values that mean the mail left. */
const SETTLED_SENDS = ['SENT', 'DELIVERED', 'READ'];

/** Bounds on the echo lookup — one address, one mailbox; never a scan. */
const MAX_IDENTITIES = 20;
const MAX_CONVERSATIONS = 50;

export interface CorroboratedReport {
  /** Addresses this workspace provably mailed. Safe to suppress. */
  corroborated: SuppressibleRecipient[];
  /** Addresses refused, and why — recorded, never acted on. */
  rejected: Array<{ address: string; reason: 'not-our-recipient' | 'over-cap' }>;
}

/**
 * Split a report's suppressible recipients into the ones this workspace can
 * prove it mailed and the ones it cannot.
 *
 * Never throws: a lookup failure returns the address as rejected, because
 * "we could not check" must fall on the side of not suppressing a customer.
 */
export async function corroborateReport(
  db: MailLogLookup,
  workspaceId: string,
  report: DeliveryReport,
  targets: readonly SuppressibleRecipient[],
  now: Date = new Date(),
): Promise<CorroboratedReport> {
  const out: CorroboratedReport = { corroborated: [], rejected: [] };
  if (!workspaceId) {
    for (const t of targets) out.rejected.push({ address: t.address, reason: 'not-our-recipient' });
    return out;
  }

  const since = new Date(now.getTime() - PROVENANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const originalMessageId = report?.originalMessageId ?? null;

  for (const t of targets) {
    if (out.corroborated.length >= MAX_SUPPRESSIONS_PER_REPORT) {
      out.rejected.push({ address: t.address, reason: 'over-cap' });
      continue;
    }
    const norm = normalizeAddress(t.address);
    if (!norm) {
      out.rejected.push({ address: t.address, reason: 'not-our-recipient' });
      continue;
    }
    let row: { id: string } | null = null;
    try {
      row = await db.mailLog.findFirst({
        where: {
          workspaceId,
          OR: [
            // The mail we are told this is about, addressed to the person the
            // report names. Both halves, or a known id suppresses strangers.
            ...(originalMessageId ? [{ messageId: originalMessageId, toAddressNorm: norm }] : []),
            // No id in the report: did we send this person anything recently?
            { toAddressNorm: norm, status: 'SENT', sentAt: { gte: since } },
          ],
        },
        select: { id: true },
      });
    } catch {
      row = null;
    }
    const proved = Boolean(row) || (await sentByMailbox(db, workspaceId, norm, originalMessageId, since));
    if (proved) out.corroborated.push(t);
    else out.rejected.push({ address: t.address, reason: 'not-our-recipient' });
  }
  return out;
}

/**
 * Did this workspace send `address` a mail that `MailLog` never saw?
 *
 * Two kinds of OUTBOUND message sit in the address's own email thread, and both
 * are mail that really left:
 * - the conversational lane's own sends (`message-sender.service.ts`: the Inbox
 *   composer, the AI reply engine, a workflow reply). That lane deliberately
 *   bypasses the gateway, so its only record is this row;
 * - the owner's own mail typed in Outlook, on a phone or in the Gmail web
 *   client, filed back as an echo by the Sent-folder reconciler — read out of
 *   their Sent folder over their own login, which nobody outside can write to.
 *
 * Same two halves as the `MailLog` match, and the same pairing:
 * - the report's id, on a message filed under THIS address's own identity —
 *   so knowing an id suppresses only the person that mail went to;
 * - or, with no id, a message to this address inside the window.
 *
 * Only a settled send counts (`SENT`, or a later `DELIVERED`/`READ`). `FAILED`
 * never left, for the reason `REFUSED` is excluded on the ledger, and
 * `PENDING` is a send whose outcome was never recorded: "we cannot tell
 * whether it left" falls on the side of not suppressing, like every other
 * unknown in this module. Never throws.
 */
async function sentByMailbox(
  db: MailLogLookup,
  workspaceId: string,
  address: string,
  originalMessageId: string | null,
  since: Date,
): Promise<boolean> {
  if (!db.contactIdentity || !db.conversation || !db.message) return false;
  try {
    const identities = await db.contactIdentity.findMany({
      where: { workspaceId, kind: 'EMAIL', value: address },
      select: { id: true },
      take: MAX_IDENTITIES,
    });
    if (!identities?.length) return false;

    const conversations = await db.conversation.findMany({
      where: { workspaceId, contactIdentityId: { in: identities.map((i) => i.id) } },
      select: { id: true },
      take: MAX_CONVERSATIONS,
    });
    if (!conversations?.length) return false;

    const spellings = originalMessageId ? [originalMessageId, `<${originalMessageId}>`] : [];
    const message = await db.message.findFirst({
      where: {
        workspaceId,
        conversationId: { in: conversations.map((c) => c.id) },
        direction: 'OUTBOUND',
        status: { in: SETTLED_SENDS },
        OR: [
          ...(spellings.length ? [{ externalMessageId: { in: spellings } }] : []),
          { createdAt: { gte: since } },
        ],
      },
      select: { id: true },
    });
    return Boolean(message);
  } catch {
    return false;
  }
}

/** One line an operator can act on, or null when everything checked out. */
export function describeRejections(rejected: CorroboratedReport['rejected']): string | null {
  if (!rejected.length) return null;
  const shown = rejected.slice(0, 5).map((r) => `${r.address} (${r.reason})`);
  const more = rejected.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}
