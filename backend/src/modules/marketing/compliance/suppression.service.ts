import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { isSingleAddress, normalizeAddress } from '../../../common/util/email-address';
import { deriveMailKey } from '../channels/lead-unsubscribe.token';
import { GATE_MATRIX, GateSet, MailClass, gateApplies } from '../channels/outbound/mail-class';
import { localMsisdnVariants, normalizePhone } from '../utils/lead-normalize';
import { ConsentLedgerService, ConsentType } from './consent-ledger.service';

/**
 * "May we mail this address?" — asked of the ADDRESS, not of a lead row.
 *
 * The bug this exists to end: `info@acme.com` is on file twice, the person
 * unsubscribes through one copy, and the next campaign reaches them through the
 * other (`optout-per-lead-row`). Consent belongs to a human being, and the only
 * handle we have on that human is the address they read mail at.
 *
 * Two sources, one verdict (the union):
 *
 * 1. `ContactSuppression` — the forward-looking audit trail. Hashed, so an
 *    erased subject leaves no readable address behind, and keyed by REASON so
 *    a hard bounce can never overwrite a KVKK tombstone.
 * 2. The denormalised `Lead` columns (`emailOptOut`, `emailBouncedAt`,
 *    `emailVerifiedStatus`) — the fast read, and the reason no backfill is
 *    needed: every opt-out already on file keeps working from day one.
 *
 * And one guarantee in the other direction: `suppress()` PROJECTS onto those
 * same columns, in the same transaction, for every matching lead. That is what
 * lets the ~200 existing call sites that read `emailOptOut` (the campaign
 * audience filter, outbound-conversation, document-email, content-distribution,
 * audience-sync) stay exactly as they are and still be right.
 *
 * Suppression is per WORKSPACE. An opt-out is a fact about a tenant
 * relationship, not about an address: a global row would both stop tenant B
 * mailing their own consented customer and leak that the address exists
 * elsewhere. Global hard-bounce suppression stays where it already is, in
 * `EspFeedbackService`, which owns that exemption.
 */

export type SuppressionKind = 'EMAIL' | 'PHONE';

export type SuppressionReason =
  /** KVKK/GDPR erasure tombstone. Never lifts, and stops even AUTH mail. */
  | 'ERASURE'
  /** The provider said this address does not exist. */
  | 'HARD_BOUNCE'
  /** Verification says the address is not deliverable. */
  | 'INVALID'
  /** The recipient pressed "spam". */
  | 'COMPLAINT'
  /** The recipient unsubscribed. */
  | 'OPT_OUT'
  /** An operator suppressed the address by hand. */
  | 'MANUAL';

export interface SuppressionVerdict {
  suppressed: boolean;
  reason?: SuppressionReason;
}

export interface SuppressOptions {
  /** 'lead-token', 'reply-keyword', 'dsn', 'esp:<provider>', … */
  source?: string | null;
  note?: string | null;
  /** The lead the click came through, when there was one. */
  leadId?: string | null;
  /** Run inside the caller's transaction instead of opening one. */
  tx?: Prisma.TransactionClient;
}

export interface CheckOptions {
  /** We are reaching out first, rather than answering an inbound message. */
  proactive?: boolean;
  /** CONVERSATIONAL: the thread whose inbound mail can earn the exemption. */
  conversationId?: string | null;
}

/**
 * Harshest first. A TRANSACTIONAL invoice ignores an opt-out but must still
 * refuse a dead address, so the answer is the harshest reason that APPLIES to
 * this class — not the first row the database happened to return.
 */
const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'ERASURE',
  'HARD_BOUNCE',
  'INVALID',
  'COMPLAINT',
  'OPT_OUT',
  'MANUAL',
] as const;

/**
 * Which gate in `GATE_MATRIX` decides this reason. The matrix is the contract
 * (§A1): the class semantics live there as data, and this service reads them
 * rather than keeping a second copy that would drift.
 *
 * `INVALID` rides the `hardBounce` gate (both are "the address does not work")
 * and `MANUAL` rides `optOut` (an operator suppressing by hand is stating the
 * tenant's own refusal).
 */
const REASON_GATE: Record<SuppressionReason, keyof GateSet> = {
  ERASURE: 'erasure',
  HARD_BOUNCE: 'hardBounce',
  INVALID: 'hardBounce',
  COMPLAINT: 'complaint',
  OPT_OUT: 'optOut',
  MANUAL: 'optOut',
};

/** The pre-ConsentRecord fallback: "did they write in recently enough". */
const LEGACY_REPLY_WINDOW_MS = 72 * 60 * 60 * 1000;

/** One projection pass; a bounded loop walks the rest. */
const PROJECTION_BATCH = 500;
const PROJECTION_MAX_BATCHES = 20;

/** How many same-address leads a single verdict reads. */
const FLAG_READ_LIMIT = 200;

/** Lead columns the union read needs. */
interface LeadFlags {
  id?: string;
  emailNormalized?: string | null;
  emailOptOut: boolean;
  emailBouncedAt: Date | null;
  emailVerifiedStatus: string;
}

function flagReasons(lead: LeadFlags): SuppressionReason[] {
  const out: SuppressionReason[] = [];
  if (lead.emailOptOut) out.push('OPT_OUT');
  if (lead.emailBouncedAt) out.push('HARD_BOUNCE');
  if (lead.emailVerifiedStatus === 'INVALID') out.push('INVALID');
  return out;
}

/** Any lead carrying at least one of the three denormalised suppressions. */
const FLAGGED_LEAD_OR = [
  { emailOptOut: true },
  { emailBouncedAt: { not: null } },
  { emailVerifiedStatus: 'INVALID' },
];

/**
 * How a reason shows up on the lead row — what the flip writes, who still
 * needs it, and how a lift puts it back.
 *
 * The load-bearing cell is `HARD_BOUNCE`: it sets `emailBouncedAt` and NOTHING
 * else. Today a bounce also sets `emailOptOut`, so correcting a typo'd address
 * clears the bounce and leaves the lead looking unsubscribed forever
 * (`bounce-sets-optout`). Machine suppression and human refusal stop sharing a
 * column here.
 */
interface Projection {
  /** The denormalised column this reason lives in — two reasons that share one
   *  column cannot be lifted independently (see `writeLift`). */
  column: 'emailOptOut' | 'emailBouncedAt' | 'emailVerifiedStatus' | 'smsOptOut';
  apply: () => Record<string, unknown>;
  /** Leads that do not carry it yet — so a repeat suppress is a real no-op. */
  pending: Record<string, unknown>;
  clear: Record<string, unknown>;
  /** Leads that still carry it — what a lift walks. */
  carried: Record<string, unknown>;
  /** Set only when the reason is about CONSENT, not about deliverability. */
  consent?: ConsentType;
}

function projectionFor(kind: SuppressionKind, reason: SuppressionReason): Projection | null {
  if (kind === 'EMAIL') {
    switch (reason) {
      case 'OPT_OUT':
      case 'COMPLAINT':
      case 'MANUAL':
        return {
          column: 'emailOptOut',
          apply: () => ({ emailOptOut: true }),
          pending: { emailOptOut: false },
          clear: { emailOptOut: false },
          carried: { emailOptOut: true },
          consent: 'MARKETING_EMAIL',
        };
      case 'HARD_BOUNCE':
        return {
          column: 'emailBouncedAt',
          apply: () => ({ emailBouncedAt: new Date() }),
          pending: { emailBouncedAt: null },
          clear: { emailBouncedAt: null },
          carried: { emailBouncedAt: { not: null } },
        };
      case 'INVALID':
        return {
          column: 'emailVerifiedStatus',
          apply: () => ({ emailVerifiedStatus: 'INVALID' }),
          pending: { emailVerifiedStatus: { not: 'INVALID' } },
          clear: { emailVerifiedStatus: 'UNKNOWN' },
          carried: { emailVerifiedStatus: 'INVALID' },
        };
      // ERASURE: the erasure transaction scrubs the lead row itself. Writing a
      // flag onto a row that is about to be overwritten says nothing.
      default:
        return null;
    }
  }
  // PHONE carries one denormalised column worth projecting. `waOptOut` is left
  // alone on purpose: a WhatsApp opt-out is its own channel decision, and the
  // İYS/NetGSM side of an SMS withdrawal belongs to ComplianceService, which
  // owns the eventing.
  if (reason === 'OPT_OUT' || reason === 'COMPLAINT' || reason === 'MANUAL') {
    return {
      column: 'smsOptOut',
      apply: () => ({ smsOptOut: true }),
      pending: { smsOptOut: false },
      clear: { smsOptOut: false },
      carried: { smsOptOut: true },
      consent: 'MARKETING_SMS',
    };
  }
  return null;
}

@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);
  private warnedNoPepper = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: ConsentLedgerService,
  ) {}

  /**
   * Put an address on the list, and project it onto every lead that shares it.
   *
   * Idempotent: the row is upserted on (workspace, kind, hash, reason) and the
   * projection only touches leads that do not carry the flag yet, so a second
   * call writes no second audit row. Bad input (no workspace, an unusable
   * value) is a silent no-op — a DB failure is not, because the public
   * unsubscribe POST has to be able to answer 5xx and be redelivered.
   */
  async suppress(
    workspaceId: string,
    value: string,
    kind: SuppressionKind,
    reason: SuppressionReason,
    opts: SuppressOptions = {},
  ): Promise<void> {
    const key = this.matchKey(kind, value);
    if (!workspaceId || !key) return;
    const run = (tx: Prisma.TransactionClient) => this.writeSuppression(tx, workspaceId, key, kind, reason, opts);
    if (opts.tx) {
      await run(opts.tx);
      return;
    }
    await this.prisma.$transaction(run);
  }

  /**
   * Withdraw a suppression — the other half of R3. `recordConsent(granted:true)`
   * clears `emailOptOut`, so without this a stale row would leave a re-consented
   * lead permanently unmailable.
   *
   * ERASURE is refused, quietly: a tombstone is the one thing consent cannot
   * undo, and throwing would turn a re-consent click into a 500.
   */
  async lift(
    workspaceId: string,
    value: string,
    kind: SuppressionKind,
    reason: SuppressionReason,
    by: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (reason === 'ERASURE') {
      this.logger.warn(`Refused to lift an ERASURE tombstone (workspace=${workspaceId}, by=${by})`);
      return;
    }
    const key = this.matchKey(kind, value);
    if (!workspaceId || !key) return;
    const run = (client: Prisma.TransactionClient) => this.writeLift(client, workspaceId, key, kind, reason, by);
    if (tx) {
      await run(tx);
      return;
    }
    await this.prisma.$transaction(run);
  }

  /**
   * May this class of mail go to this address?
   *
   * Never throws and never guesses: an address nothing is on record against is
   * allowed, and the reason returned is the harshest one the class actually
   * gates on.
   */
  async check(
    workspaceId: string,
    address: string,
    mailClass: MailClass,
    opts: CheckOptions = {},
  ): Promise<SuppressionVerdict> {
    const key = normalizeAddress(address);
    if (!workspaceId || !key) return { suppressed: false };

    const [rows, flagged] = await Promise.all([
      this.rowReasons(workspaceId, 'EMAIL', key),
      this.flaggedLeads(workspaceId, key),
    ]);
    const reasons = new Set<SuppressionReason>([...rows, ...flagged.reasons]);
    if (!reasons.size) return { suppressed: false };

    const gates = GATE_MATRIX[mailClass];
    let proactive = opts.proactive === true;
    // The reply exemption (`replies-skip-consent`): a customer who unsubscribed
    // and then wrote in must get an answer, but a follow-up we queue hours
    // later is not an answer. Only CONVERSATIONAL has proactive-gated cells, so
    // this probe costs a query only where it can change the verdict.
    if (!proactive && [...reasons].some((r) => gates[REASON_GATE[r]] === 'proactive')) {
      proactive = !(await this.repliedSinceOptOut(workspaceId, opts.conversationId, flagged.leadIds));
    }

    for (const reason of SUPPRESSION_REASONS) {
      if (reasons.has(reason) && gateApplies(gates[REASON_GATE[reason]], { proactive })) {
        return { suppressed: true, reason };
      }
    }
    return { suppressed: false };
  }

  /**
   * The audience-sized answer: two queries for a whole batch.
   *
   * Keyed by the strings the CALLER passed, so a campaign can filter its own
   * list without re-normalising. Every mail is treated as proactive — there is
   * no one conversation to probe here, and "we are about to start N sends" is
   * exactly the proactive case.
   */
  async checkMany(
    workspaceId: string,
    addresses: string[],
    mailClass: MailClass,
  ): Promise<Map<string, SuppressionReason>> {
    const out = new Map<string, SuppressionReason>();
    const inputs = (addresses ?? []).filter((a): a is string => typeof a === 'string');
    if (!workspaceId || !inputs.length) return out;

    const byKey = new Map<string, string[]>();
    for (const input of inputs) {
      const key = normalizeAddress(input);
      if (!key) continue;
      const seen = byKey.get(key);
      if (seen) seen.push(input);
      else byKey.set(key, [input]);
    }
    if (!byKey.size) return out;

    const keys = [...byKey.keys()];
    const reasons = new Map<string, Set<SuppressionReason>>();
    const add = (key: string, reason: SuppressionReason) => {
      const seen = reasons.get(key);
      if (seen) seen.add(reason);
      else reasons.set(key, new Set([reason]));
    };

    const byHash = new Map<string, string>();
    for (const key of keys) {
      const hash = this.hash('EMAIL', key);
      if (hash) byHash.set(hash, key);
    }
    if (byHash.size) {
      const rows = await this.prisma.contactSuppression.findMany({
        where: { workspaceId, kind: 'EMAIL', hash: { in: [...byHash.keys()] }, liftedAt: null },
        select: { hash: true, reason: true },
      });
      for (const row of rows) {
        const key = byHash.get(row.hash);
        if (key) add(key, row.reason as SuppressionReason);
      }
    }

    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, emailNormalized: { in: keys }, OR: FLAGGED_LEAD_OR },
      select: { emailNormalized: true, emailOptOut: true, emailBouncedAt: true, emailVerifiedStatus: true },
      take: 5000,
    });
    for (const lead of leads) {
      if (!lead.emailNormalized) continue;
      for (const reason of flagReasons(lead)) add(lead.emailNormalized, reason);
    }

    const gates = GATE_MATRIX[mailClass];
    for (const [key, set] of reasons) {
      for (const reason of SUPPRESSION_REASONS) {
        if (set.has(reason) && gateApplies(gates[REASON_GATE[reason]], { proactive: true })) {
          for (const input of byKey.get(key) ?? []) out.set(input, reason);
          break;
        }
      }
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async writeSuppression(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    key: string,
    kind: SuppressionKind,
    reason: SuppressionReason,
    opts: SuppressOptions,
  ): Promise<void> {
    const hash = this.hash(kind, key);
    if (hash) {
      await tx.contactSuppression.upsert({
        where: { workspaceId_kind_hash_reason: { workspaceId, kind, hash, reason } },
        create: {
          workspaceId,
          kind,
          hash,
          reason,
          source: opts.source ?? null,
          note: opts.note ?? null,
        },
        // Re-asserting a lifted suppression un-lifts it, and the latest
        // assertion is the one worth keeping the provenance of.
        update: { liftedAt: null, source: opts.source ?? null, note: opts.note ?? null },
      });
    }

    const projection = projectionFor(kind, reason);
    // The clicked lead is included by id as well as by address: a lead whose
    // address was edited after the mail went out is still the person who just
    // pressed unsubscribe.
    const address = this.leadMatch(kind, key, opts.leadId);
    if (!projection || !address) return;

    for (let batch = 0; batch < PROJECTION_MAX_BATCHES; batch++) {
      const pending = await tx.lead.findMany({
        where: { workspaceId, ...address, ...projection.pending },
        select: { id: true },
        take: PROJECTION_BATCH,
      });
      if (!pending.length) return;
      const leadIds = pending.map((l) => l.id);
      await tx.lead.updateMany({ where: { workspaceId, id: { in: leadIds } }, data: projection.apply() });
      if (projection.consent) {
        await this.ledger.record(
          { workspaceId, leadIds, type: projection.consent, granted: false, source: opts.source ?? null },
          tx,
        );
      }
      if (pending.length < PROJECTION_BATCH) return;
    }
    this.logger.warn(`Suppression projection hit its batch ceiling (workspace=${workspaceId}, kind=${kind})`);
  }

  private async writeLift(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    key: string,
    kind: SuppressionKind,
    reason: SuppressionReason,
    by: string,
  ): Promise<void> {
    const hash = this.hash(kind, key);
    if (hash) {
      await tx.contactSuppression.updateMany({
        where: { workspaceId, kind, hash, reason, liftedAt: null },
        data: { liftedAt: new Date(), note: `lifted by ${by}`.slice(0, 200) },
      });
    }

    const projection = projectionFor(kind, reason);
    const address = this.addressWhere(kind, key);
    if (!projection || !address) return;

    // Another standing reason may share the same column — a lifted opt-out
    // must not clear a flag a live complaint still demands.
    if (hash) {
      const remaining = await this.rowReasons(workspaceId, kind, key, tx);
      const stillDemanded = remaining.some((r) => projectionFor(kind, r)?.column === projection.column);
      if (stillDemanded) return;
    }

    for (let batch = 0; batch < PROJECTION_MAX_BATCHES; batch++) {
      const carrying = await tx.lead.findMany({
        where: { workspaceId, ...address, ...projection.carried },
        select: { id: true },
        take: PROJECTION_BATCH,
      });
      if (!carrying.length) return;
      const leadIds = carrying.map((l) => l.id);
      await tx.lead.updateMany({ where: { workspaceId, id: { in: leadIds } }, data: projection.clear });
      // A cleared bounce is not restored consent — only the consent-bearing
      // reasons produce a granted:true row.
      if (projection.consent) {
        await this.ledger.record(
          { workspaceId, leadIds, type: projection.consent, granted: true, source: `lift:${by}` },
          tx,
        );
      }
      if (carrying.length < PROJECTION_BATCH) return;
    }
    this.logger.warn(`Suppression lift hit its batch ceiling (workspace=${workspaceId}, kind=${kind})`);
  }

  /** Unlifted reasons on record for this address, from the table. */
  private async rowReasons(
    workspaceId: string,
    kind: SuppressionKind,
    key: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SuppressionReason[]> {
    const hash = this.hash(kind, key);
    if (!hash) return [];
    const rows = await (tx ?? this.prisma).contactSuppression.findMany({
      where: { workspaceId, kind, hash, liftedAt: null },
      select: { reason: true },
    });
    return rows.map((r) => r.reason as SuppressionReason);
  }

  /** Reasons carried by the denormalised columns, plus the leads carrying them. */
  private async flaggedLeads(
    workspaceId: string,
    key: string,
  ): Promise<{ reasons: SuppressionReason[]; leadIds: string[] }> {
    if (!isSingleAddress(key)) return { reasons: [], leadIds: [] };
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, emailNormalized: key, OR: FLAGGED_LEAD_OR },
      select: { id: true, emailOptOut: true, emailBouncedAt: true, emailVerifiedStatus: true },
      take: FLAG_READ_LIMIT,
    });
    const reasons = new Set<SuppressionReason>();
    for (const lead of leads) for (const reason of flagReasons(lead)) reasons.add(reason);
    return { reasons: [...reasons], leadIds: leads.map((l) => l.id) };
  }

  /**
   * Did the customer write in AFTER they opted out?
   *
   * The opt-out moment is the latest `ConsentRecord{granted:false}` — the model
   * already exists and both writers now fill it, so no new column. Rows written
   * before that was true fall back to "did they write in within 72 hours",
   * which is the same question asked with less precision.
   */
  private async repliedSinceOptOut(
    workspaceId: string,
    conversationId: string | null | undefined,
    leadIds: string[],
  ): Promise<boolean> {
    if (!conversationId) return false;
    let optOutAt: Date | null = null;
    if (leadIds.length) {
      const withdrawal = await this.prisma.consentRecord.findFirst({
        where: { workspaceId, leadId: { in: leadIds }, type: 'MARKETING_EMAIL', granted: false },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      optOutAt = withdrawal?.createdAt ?? null;
    }
    const since = optOutAt ?? new Date(Date.now() - LEGACY_REPLY_WINDOW_MS);
    const inbound = await this.prisma.message.findFirst({
      where: { workspaceId, conversationId, direction: 'INBOUND', createdAt: { gt: since } },
      select: { id: true },
    });
    return !!inbound;
  }

  /** Trim/lowercase an address, or reduce a phone to its digits. */
  private matchKey(kind: SuppressionKind, value: string): string | null {
    return kind === 'EMAIL' ? normalizeAddress(value) : normalizePhone(value);
  }

  /**
   * The lead filter for this value — or null, which means "do not project".
   *
   * The null is the guard `esp-feedback.service.ts:33` already carries and the
   * reason it exists: `{ emailNormalized: null }` would opt out every
   * email-less lead in the workspace. A suppression row for an unusable value
   * is still written (it stays matchable), it just never becomes a filter.
   */
  private addressWhere(kind: SuppressionKind, key: string): Record<string, unknown> | null {
    if (kind === 'EMAIL') return isSingleAddress(key) ? { emailNormalized: key } : null;
    // Leads are stored under whichever spelling they arrived in, so a phone
    // match has to span all of them (see localMsisdnVariants).
    return /^\d{7,15}$/.test(key) ? { phoneNormalized: { in: localMsisdnVariants(key) } } : null;
  }

  /**
   * The same filter, widened by the lead the decision came through.
   *
   * Callers spread this next to a literal `workspaceId`, never inside it, so
   * the workspace scope stays visible at the call site (and to
   * `workspace-scoping.arch.spec.ts`). A lead id from another tenant therefore
   * matches nothing.
   */
  private leadMatch(
    kind: SuppressionKind,
    key: string,
    leadId?: string | null,
  ): Record<string, unknown> | null {
    const address = this.addressWhere(kind, key);
    if (!leadId) return address;
    return address ? { OR: [address, { id: leadId }] } : { id: leadId };
  }

  /**
   * HMAC-SHA256(pepper, "<kind>:<value>") — the stored `hash`.
   *
   * Hashed so an erased subject leaves no readable address in the table, and
   * peppered rather than plainly digested so the table is not a rainbow-table
   * lookup of "is this person a customer". The kind is inside the MAC: an
   * address and a phone can never collide into one row.
   *
   * Null when `MARKETING_SECRET_KEY` is absent — the table is then skipped and
   * the denormalised flags carry the verdict alone, which is exactly today's
   * behaviour rather than a new failure.
   */
  private hash(kind: SuppressionKind, key: string): string | null {
    const pepper = deriveMailKey('contact-suppression');
    if (!pepper) {
      if (!this.warnedNoPepper) {
        this.warnedNoPepper = true;
        this.logger.warn('MARKETING_SECRET_KEY is not set — address suppression falls back to the lead flags');
      }
      return null;
    }
    return createHmac('sha256', pepper).update(`${kind}:${key}`).digest('hex');
  }
}
