import { PrismaService } from '../../../../prisma/prisma.service';
import { normalizeAddress } from '../../../../common/util/email-address';
import { normalizeEmail } from '../../utils/lead-normalize';
import { normalizeMessageId } from '../email-message-id';
import { domainOf, isFreemailDomain } from '../smtp-autodiscover';
import { InboundSkipReason, parseAddressList } from './inbound-mail.types';

/**
 * Who gets to become a lead, and who the mail is actually from.
 *
 * ## The two decisions
 *
 * 1. **Identity.** A contact-form relay mails as `wordpress@site.com` and puts
 *    the enquirer in `Reply-To`. Reading only the From files every enquiry on
 *    one fake lead named after the website — and the name sticks, because the
 *    AI's capture path fills only EMPTY fields. The override is resolved in
 *    ONE place so the IMAP poller and the webhook cannot disagree.
 * 2. **Policy.** Today every human mail in the INBOX becomes a lead, fires
 *    `lead.created` workflows and gets an AI answer: the accountant, the
 *    supplier, a colleague and a calendar invite all land in the CRM and in a
 *    nurture sequence (İYS risk). `REPLIES_AND_KNOWN` narrows that to people we
 *    are already talking to.
 *
 * ## Three rules that are not negotiable
 *
 * - **G3 — existing channels keep today's behaviour.** A missing
 *   `inboundPolicy` reads as `ALL_SENDERS`. The knob is new; the mailbox is
 *   not, and a silent narrowing would make a live shared inbox look broken.
 * - **Nothing is dropped, only classified.** A `false` here means the item is
 *   recorded in the `EmailInboundItem` ledger with `policy-not-a-lead` and a
 *   one-click "make this a lead" — never that the mail disappears.
 * - **Fail open.** If the database cannot answer, the mail is ingested. A
 *   policy question is not worth losing a customer's reply over.
 */

export const REPLIES_AND_KNOWN = 'REPLIES_AND_KNOWN';
export const ALL_SENDERS = 'ALL_SENDERS';

export type InboundPolicy = typeof REPLIES_AND_KNOWN | typeof ALL_SENDERS;

/** What a channel connected BEFORE this change has always done (G3). */
export const DEFAULT_INBOUND_POLICY: InboundPolicy = ALL_SENDERS;

/** What a channel connected from now on starts with (G3's other half). */
export const NEW_CHANNEL_INBOUND_POLICY: InboundPolicy = REPLIES_AND_KNOWN;

/** Read the knob off `Channel.configPublic`, defaulting to today's behaviour. */
export function readInboundPolicy(configPublic: unknown): InboundPolicy {
  const raw = (configPublic as { inboundPolicy?: unknown } | null | undefined)?.inboundPolicy;
  return raw === REPLIES_AND_KNOWN || raw === ALL_SENDERS ? raw : DEFAULT_INBOUND_POLICY;
}

/** One mailbox, however the caller happens to be holding it. */
export type AddressLike =
  | { address?: string | null; name?: string | null }
  | readonly { address?: string | null; name?: string | null }[]
  | string
  | null
  | undefined;

export interface SenderIdentity {
  /** Normalised, lower-cased. Empty when the mail named no usable sender. */
  address: string;
  /** The display name that belongs to THAT address — never the relay's. */
  name: string;
  /** True when `Reply-To` won, i.e. this is a relayed form submission. */
  overridden: boolean;
  /** The resolved address is one of the mailbox's own — the caller drops it. */
  own: boolean;
}

export interface SenderIdentityInput {
  from?: AddressLike;
  replyTo?: AddressLike;
  /** fromEmail / smtpUser / the channel externalId. */
  ownAddresses?: readonly (string | null | undefined)[];
}

/**
 * Who this mail is from, after the contact-form relay is seen through.
 *
 * The trigger is deliberately narrow: a `Reply-To` in a DIFFERENT domain. A
 * form relay points at the submitter (another domain); a vendor newsletter
 * points `noreply@vendor.com` at `sales@vendor.com` (the same one) and must go
 * on being skipped by the daemon rules.
 *
 * Order is the whole point. The swap happens BEFORE the own-address check, so
 * a form that mails from the mailbox itself is rescued, and the check is then
 * re-run on the RESOLVED address, so a form that left `Reply-To` on our own
 * address cannot start a self-reply loop.
 */
export function resolveSenderIdentity(input: SenderIdentityInput): SenderIdentity {
  const from = firstAddress(input?.from);
  const replyTo = firstAddress(input?.replyTo);
  const own = new Set(
    (input?.ownAddresses ?? []).map((v) => normalizeAddress(v ?? '')).filter(Boolean) as string[],
  );

  let resolved = from;
  let overridden = false;
  if (from.address && replyTo.address) {
    const fromDomain = domainOf(from.address);
    const replyDomain = domainOf(replyTo.address);
    if (fromDomain && replyDomain && fromDomain !== replyDomain) {
      resolved = replyTo;
      overridden = true;
    }
  }

  return {
    address: resolved.address,
    // The name of the RESOLVED identity. Falling back to the relay's would name
    // every form lead after the website, permanently.
    name: resolved.name,
    overridden,
    own: Boolean(resolved.address) && own.has(resolved.address),
  };
}

/** The channel slice the policy reads. `configPublic` is the raw JSON column. */
export interface InboundPolicyChannel {
  id: string;
  workspaceId: string;
  configPublic?: unknown;
  /** fromEmail / smtpUser / externalId — whatever this mailbox answers to. */
  ownAddresses?: readonly (string | null | undefined)[];
}

/** What the caller knows about the item before anything is ingested. */
export interface InboundPolicyContext {
  /** The RESOLVED sender address (`resolveSenderIdentity`), not the raw From. */
  from: string;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
}

export interface InboundPolicyDecision {
  ingest: boolean;
  policy: InboundPolicy;
  /** The ledger code. Null when the item is ingested. */
  reason: InboundSkipReason | null;
  /** Which rule decided, for the debug log and the health card. */
  detail: string | null;
}

const ingestNow = (policy: InboundPolicy, detail: string): InboundPolicyDecision => ({
  ingest: true,
  policy,
  reason: null,
  detail,
});

const notALead = (policy: InboundPolicy, detail: string): InboundPolicyDecision => ({
  ingest: false,
  policy,
  reason: 'policy-not-a-lead',
  detail,
});

/**
 * Should this mail open (or continue) a conversation in this workspace?
 *
 * Called by BOTH the IMAP poller and the inbound webhook — putting it in one of
 * them is how the webhook ended up with none of the poller's rules.
 */
export async function shouldIngest(
  prisma: PrismaService,
  channel: InboundPolicyChannel,
  ctx: InboundPolicyContext,
): Promise<InboundPolicyDecision> {
  const policy = readInboundPolicy(channel?.configPublic);
  const address = normalizeAddress(ctx?.from ?? '');
  if (!address) {
    return { ingest: false, policy, reason: 'no-sender', detail: 'no usable sender address' };
  }
  // Today's behaviour, and the answer a shared sales inbox deliberately chose.
  // No query: the fast path stays as cheap as it is now.
  if (policy === ALL_SENDERS) return ingestNow(policy, 'all-senders');

  try {
    const mailboxDomain = domainOf(firstOwn(channel?.ownAddresses) ?? '');
    const senderDomain = domainOf(address);
    // A colleague answering from their own mailbox is not the customer, and
    // filing their words as the customer's is worse than not filing them at
    // all — so this outranks even a matching In-Reply-To.
    if (
      mailboxDomain &&
      senderDomain &&
      mailboxDomain === senderDomain &&
      !isFreemailDomain(mailboxDomain)
    ) {
      return notALead(policy, 'own-domain');
    }

    const member = await prisma.workspaceMembership.findFirst({
      where: {
        workspaceId: channel.workspaceId,
        status: 'ACTIVE',
        user: { email: { equals: address, mode: 'insensitive' } },
      },
      select: { id: true },
    });
    if (member) return notALead(policy, 'workspace-member');

    // A reply to mail WE sent. Both spellings, because outbound ids were
    // persisted with angle brackets and inbound ones without — one normaliser
    // on one side matches nothing at all.
    const parents = messageIdCandidates(ctx);
    if (parents.length) {
      const message = await prisma.message.findFirst({
        where: { workspaceId: channel.workspaceId, externalMessageId: { in: parents } },
        select: { id: true },
      });
      if (message) return ingestNow(policy, 'reply-to-our-message');
      // Campaign, quote, invoice and booking mail leave a MailLog row and no
      // conversation message, so a reply to one is only visible here.
      const logged = await prisma.mailLog.findFirst({
        where: { workspaceId: channel.workspaceId, messageId: { in: parents } },
        select: { id: true },
      });
      if (logged) return ingestNow(policy, 'reply-to-our-mail');
    }

    const identity = await prisma.contactIdentity.findFirst({
      where: { workspaceId: channel.workspaceId, channelId: channel.id, value: address },
      select: { id: true },
    });
    if (identity) return ingestNow(policy, 'known-identity');

    const lead = await prisma.lead.findFirst({
      where: {
        workspaceId: channel.workspaceId,
        emailNormalized: normalizeEmail(address),
        deletedAt: null,
        mergedIntoId: null,
      },
      select: { id: true },
    });
    if (lead) return ingestNow(policy, 'known-lead');

    return notALead(policy, 'unknown-sender');
  } catch {
    // Fail OPEN. A transient database error must not turn into a silently
    // dropped customer mail — the ledger and the inbox are what this whole
    // pipeline exists to keep honest.
    return ingestNow(policy, 'policy-unavailable');
  }
}

/** Both spellings of every id this mail claims to answer. */
function messageIdCandidates(ctx: InboundPolicyContext): string[] {
  const ids = [ctx?.inReplyTo, ...(ctx?.references ?? [])]
    .map((v) => normalizeMessageId(v))
    .filter(Boolean) as string[];
  const out: string[] = [];
  for (const id of ids) {
    if (!out.includes(id)) out.push(id);
    const bracketed = `<${id}>`;
    if (!out.includes(bracketed)) out.push(bracketed);
  }
  return out;
}

/** The first of the mailbox's own addresses that parses. */
function firstOwn(values: readonly (string | null | undefined)[] | undefined): string | null {
  for (const v of values ?? []) {
    const address = normalizeAddress(v ?? '');
    if (address) return address;
  }
  return null;
}

/**
 * One mailbox out of whatever shape the caller had.
 *
 * A raw string is a HEADER, not an address: `"Hummy Tummy" <admin@…>` is what
 * the adapter and the poller are holding. It goes through the one shared
 * parser — which also carries the display name, and refuses a value with a
 * newline written into it — rather than being normalised as if it were already
 * bare. Reading it as bare is how the own-address check stopped matching and
 * the mailbox started answering itself.
 */
function firstAddress(value: AddressLike): { address: string; name: string } {
  if (!value) return { address: '', name: '' };
  if (typeof value === 'string') {
    const parsed = parseAddressList(value)[0];
    return { address: parsed?.address ?? '', name: parsed?.name ?? '' };
  }
  if (Array.isArray(value)) return firstAddress(value[0] ?? null);
  const one = value as { address?: string | null; name?: string | null };
  return { address: normalizeAddress(one.address ?? '') ?? '', name: String(one.name ?? '').trim() };
}
