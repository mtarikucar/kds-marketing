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
 * A `MailLog` row in THIS workspace addressed to THIS recipient:
 *
 * - matched by `Original-Message-ID` when the report carried one. The ids are
 *   UUID-seeded (`email-message-id.ts`), so they cannot be guessed — but they
 *   CAN be known by anyone who received mail from the tenant, which is why the
 *   row's recipient must match the reported one too. Knowing a Message-ID must
 *   not become a licence to suppress a third party.
 * - otherwise by address, over a bounded window. `Original-Message-ID` is
 *   genuinely often absent (delivery-report.ts says so), and refusing every
 *   report without one would throw away the feature's whole reason for
 *   existing: the typo'd address we really did mail.
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

/** The slice of Prisma this needs — narrow, so tests hand it a plain object. */
export interface MailLogLookup {
  mailLog: { findFirst: (args: any) => Promise<{ id: string } | null> };
}

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
    if (row) out.corroborated.push(t);
    else out.rejected.push({ address: t.address, reason: 'not-our-recipient' });
  }
  return out;
}

/** One line an operator can act on, or null when everything checked out. */
export function describeRejections(rejected: CorroboratedReport['rejected']): string | null {
  if (!rejected.length) return null;
  const shown = rejected.slice(0, 5).map((r) => `${r.address} (${r.reason})`);
  const more = rejected.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}
