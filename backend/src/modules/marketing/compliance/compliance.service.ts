import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Lead } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes, MarketingSmsOptStatusPayload } from '../events/marketing-event-types';
import { IysSyncService } from './iys-sync.service';
import { SuppressionService } from './suppression.service';

/** Placeholder written over a name once its owner has exercised erasure. */
const ERASED_MARKER = '[Silinmiş]';

const OPT_OUT_FIELD: Record<string, 'emailOptOut' | 'smsOptOut' | 'waOptOut'> = {
  MARKETING_EMAIL: 'emailOptOut',
  MARKETING_SMS: 'smsOptOut',
  MARKETING_WHATSAPP: 'waOptOut',
};

/**
 * How far the erasure follows `mergedIntoId`.
 *
 * `lead-dedupe.service.ts` only refuses a canonical that is CURRENTLY merged,
 * so A→B followed by B→C is legal and leaves a depth-2 chain. The cap is
 * insurance against a cycle an older merge could have left behind, not a
 * statement about how deep real chains go — visited ids are tracked anyway,
 * so a cycle terminates on its own.
 */
const MERGE_CHAIN_MAX_HOPS = 10;

/**
 * How long an export body is kept (`export-stored-forever`).
 *
 * The payload is the artifact proving WHAT was disclosed under Art. 15, so it
 * is still written — it just stops being a plaintext copy of the subject that
 * outlives every purpose it had. The audit row (kind / leadId / completedAt)
 * is never touched.
 */
const EXPORT_PAYLOAD_TTL_DAYS = 90;

interface ConsentMeta {
  source?: string;
  ipAddress?: string;
}

/**
 * Epic F (compliance) — GDPR/KVKK consent log + data subject requests.
 * Recording a marketing consent also syncs the Lead's per-channel opt-out flag
 * (so the campaign engine honours it). EXPORT returns the data; ERASURE is
 * recorded PENDING for reviewed execution (never auto-deletes).
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly iysSync: IysSyncService,
    private readonly suppression: SuppressionService,
  ) {}

  private async assertLead(workspaceId: string, leadId: string) {
    const l = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { id: true },
    });
    if (!l) throw new NotFoundException('Lead not found');
  }

  async recordConsent(
    workspaceId: string,
    leadId: string,
    type: string,
    granted: boolean,
    meta: ConsentMeta = {},
  ) {
    await this.assertLead(workspaceId, leadId);
    const field = OPT_OUT_FIELD[type];

    if (field === 'smsOptOut') {
      // The ConsentRecord write and the smsOptOut flip commit ATOMICALLY
      // together (both or neither) inside emitSmsOptEvent's own transaction
      // — see its docstring. The blacklist-mirror event + İYS enqueue stay
      // best-effort WITHIN that committed consent (their own savepoints).
      return this.emitSmsOptEvent(workspaceId, leadId, type, granted, meta);
    }

    // The ConsentRecord write and the opt-out flag flip must commit ATOMICALLY,
    // exactly like the SMS path (emitSmsOptEvent): a committed ConsentRecord must
    // always carry its matching flag state. Without the transaction, a flip that
    // fails after the record commits leaves a recorded email/wa opt-out whose flag
    // stayed false — and the send path reads ONLY the flag (campaign-sender
    // isOptedOut / campaigns audience filter), so the contact keeps receiving
    // campaigns despite an on-record opt-out (a KVKK/GDPR divergence).
    const record = await this.prisma.$transaction(async (tx) => {
      const created = await tx.consentRecord.create({
        data: { workspaceId, leadId, type, granted, source: meta.source, ipAddress: meta.ipAddress },
      });
      if (field) {
        // granted=false → opted OUT (true); granted=true → opted IN (false).
        await tx.lead.update({ where: { id: leadId }, data: { [field]: !granted } });
      }
      if (type === 'MARKETING_EMAIL' && granted) {
        await this.liftEmailSuppression(tx, workspaceId, leadId, created.id);
      }
      return created;
    });

    // The İYS half of an email withdrawal — reported only once the consent
    // record above has COMMITTED, and never able to unwind it. See
    // `reportEmailWithdrawal` for why the other direction is not pushed.
    if (type === 'MARKETING_EMAIL' && !granted) {
      await this.reportEmailWithdrawal(workspaceId, leadId, meta.source);
    }
    return record;
  }

  /**
   * Tell İYS the recipient withdrew — the email counterpart of the `MESAJ`
   * push `emitSmsOptEvent` makes.
   *
   * `RET` ONLY, deliberately. A grant recorded through this method is a staff
   * member ticking a box in the CRM, and nothing on this path can tell that
   * from the recipient's own evidenced act (a double opt-in, a public form,
   * an IP and a timestamp). Pushing it as an İYS `ONAY` would assert a consent
   * the tenant cannot evidence when İYS asks — so the platform reports the
   * withdrawal it is obliged to report and stays silent about the rest.
   *
   * Inert for every workspace that has not armed `settings.email.iys.eposta`
   * with credentials, and best-effort in every case: the ConsentRecord and the
   * flag are the compliance record, the push is the mirror.
   */
  private async reportEmailWithdrawal(workspaceId: string, leadId: string, source?: string): Promise<void> {
    try {
      const lead = await this.prisma.lead.findUnique({
        where: { id: leadId },
        select: { email: true, emailNormalized: true },
      });
      const address = lead?.emailNormalized || lead?.email || null;
      if (!address) return;
      await this.iysSync.enqueueEmailWithdrawal({
        workspaceId,
        leadId,
        address,
        // An İYS-originated write carries its own `IYS_` tag through, so the
        // producer's anti-feedback-loop guard can drop it; every other caller
        // is a web action, which is what `HS_WEB` means.
        source: source?.startsWith('IYS_') ? source : 'HS_WEB',
      });
    } catch (e: any) {
      this.logger.warn(`Failed to report the İYS EPOSTA withdrawal for lead=${leadId}: ${e?.message ?? e}`);
    }
  }

  /**
   * R3 — fresh consent has to reach the suppression list, not just the flag.
   *
   * `SuppressionService.check` answers with the UNION of the ContactSuppression
   * row and the denormalised `emailOptOut` column, so clearing the flag alone
   * would leave a re-consented lead permanently unmailable behind a row nobody
   * ever withdrew — the exact drift three reviewers named in advance.
   *
   * It runs in the caller's transaction on purpose: a consent that half-applied
   * is worse than one that failed, and the record+flip pair above already
   * demands that atomicity.
   *
   * Order matters. The flag flip happens FIRST (above), so this lead no longer
   * carries `emailOptOut` when `lift` sweeps the leads that still do — it keeps
   * its own ConsentRecord, written one line earlier, instead of collecting a
   * second one from the ledger. Every OTHER lead on the same address is exactly
   * who the sweep is for (`optout-per-lead-row`): consent belongs to the person,
   * not to whichever copy of their row the click came through.
   *
   * SMS is deliberately NOT wired here. Nothing reads a PHONE suppression yet
   * (`check`/`checkMany` are EMAIL-only), so there is no stale row to clear —
   * and an SMS withdrawal owns İYS + the NetGSM account blacklist through
   * `emitSmsOptEvent`, which a silent flag sweep must not step around.
   */
  private async liftEmailSuppression(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    leadId: string,
    recordId: string,
  ) {
    const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { emailNormalized: true } });
    if (!lead?.emailNormalized) return;
    await this.suppression.lift(
      workspaceId,
      lead.emailNormalized,
      'EMAIL',
      'OPT_OUT',
      `consent:${recordId}`,
      tx,
    );
  }

  /**
   * Writes the ConsentRecord AND flips the lead's smsOptOut flag inside ONE
   * $transaction — both commit together or neither does. A committed
   * ConsentRecord must ALWAYS have its matching flag state; there is no
   * later, separate write that could commit the record while the flip is
   * lost (or vice versa).
   *
   * The same transaction also mirrors the transition to
   * NetgsmBlacklistSyncService via the outbox (defense-in-depth NetGSM
   * account-blacklist sync — see that service's docstring) — the standard
   * outbox idiom used by every other producer in this codebase (state write
   * + event insert atomic together when the append succeeds).
   *
   * The one difference from those producers: this event is best-effort — the
   * opt-out flag itself is the durable compliance record; the blacklist sync
   * is only defense-in-depth (İYS + the app's own smsOptOut gates are
   * primary) — so a failure reading the lead's phone OR appending the event
   * must NEVER fail the request or undo the record+flip. A plain try/catch
   * around those two steps is NOT enough to protect them: Postgres aborts the
   * WHOLE transaction the instant any statement inside it errors, and Prisma
   * silently turns the eventual COMMIT into a no-op ROLLBACK even when the JS
   * error was caught (verified empirically against a real Postgres instance —
   * a caught inner error still discarded every earlier write in the same
   * interactive transaction). The SAVEPOINT below isolates the read+append:
   * on failure, only that sub-scope rolls back and the record+flip commit
   * normally.
   *
   * Phase 2 Task 3 (İYS auto-push) adds a SECOND, INDEPENDENT savepoint block
   * right after this one that enqueues an IysSyncJob via IysSyncService — its
   * own savepoint (not shared with the blacklist-mirror block above) so a
   * failure in EITHER best-effort mirror can never take down the other, and
   * neither can ever touch the ConsentRecord write or the smsOptOut flip
   * itself — the İYS enqueue is best-effort-within-the-committed-consent.
   * Only MARKETING_SMS consent maps to İYS (type MESAJ) — ARAMA (call
   * consent) lands with Phase 5's voice campaigns.
   */
  private async emitSmsOptEvent(
    workspaceId: string,
    leadId: string,
    type: string,
    granted: boolean,
    meta: ConsentMeta,
  ) {
    const eventType = granted ? MarketingEventTypes.SmsOptedIn : MarketingEventTypes.SmsOptedOut;
    const direction = granted ? 'ONAY' : 'RET';
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.consentRecord.create({
        data: { workspaceId, leadId, type, granted, source: meta.source, ipAddress: meta.ipAddress },
      });
      await tx.lead.update({ where: { id: leadId }, data: { smsOptOut: !granted } });

      await tx.$executeRawUnsafe('SAVEPOINT sp_sms_opt_event');
      try {
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
        if (lead?.phone) {
          await this.outbox.append(
            {
              type: eventType,
              tenantId: null,
              payload: { workspaceId, leadId, phone: lead.phone } satisfies MarketingSmsOptStatusPayload,
              idempotencyKey: `${workspaceId}:${leadId}:${eventType}:consent:${record.id}`,
            },
            tx,
          );
        }
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp_sms_opt_event');
      } catch (e: any) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp_sms_opt_event');
        this.logger.warn(`Failed to enqueue ${eventType} for lead=${leadId}: ${e?.message ?? e}`);
      }

      await tx.$executeRawUnsafe('SAVEPOINT sp_iys_enqueue');
      try {
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
        await this.iysSync.enqueueConsent(tx, {
          workspaceId,
          leadId,
          recipient: lead?.phone,
          direction,
          // İYS-ORIGINATED writes (IysWebhookConsumer, Phase 2 Task 4) tag
          // meta.source `IYS_<originalSource>` — passed straight through here
          // so IysSyncService.enqueueConsent's own IYS_ guard can catch it
          // and skip re-submitting the change back to İYS (a feedback loop).
          // Every OTHER caller (dashboard consent toggle, public unsubscribe
          // link) still gets the fixed 'HS_WEB' İYS source code it always
          // had — meta.source there is an APP-level tag ('form', 'crm', …),
          // not an İYS source code, so it must never be forwarded as-is.
          source: meta.source?.startsWith('IYS_') ? meta.source : 'HS_WEB',
          consentAt: new Date(),
        });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp_iys_enqueue');
      } catch (e: any) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp_iys_enqueue');
        this.logger.warn(`Failed to enqueue İYS sync job for lead=${leadId}: ${e?.message ?? e}`);
      }

      return record;
    });
  }

  async getConsents(workspaceId: string, leadId: string) {
    await this.assertLead(workspaceId, leadId);
    const all = await this.prisma.consentRecord.findMany({
      where: { workspaceId, leadId },
      orderBy: { createdAt: 'desc' },
    });
    // `source` rides along: dating an opt-out answers half of what a compliance
    // officer is asked, and the other half is whether the person unticked a
    // form, replied STOP or a rep did it for them. Explicitly null — never
    // absent — on a record written before sources were captured.
    const latest: Record<
      string,
      { type: string; granted: boolean; at: Date; source: string | null }
    > = {};
    for (const r of all) {
      if (!(r.type in latest)) {
        latest[r.type] = { type: r.type, granted: r.granted, at: r.createdAt, source: r.source ?? null };
      }
    }
    return Object.values(latest);
  }

  async requestExport(workspaceId: string, leadId: string, requestedById?: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      include: { activities: true, offers: true, tasks: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    // A DSAR (GDPR Art. 15 / KVKK right of access) must return ALL personal data
    // held about the subject — not just lead+activities+offers+tasks. Pull every
    // lead-scoped personal-data category (each explicitly workspace+lead scoped).
    // Communications, appointments, documents, financials and call records were
    // previously omitted, making the export incomplete.
    const [
      consents,
      conversations,
      bookings,
      documents,
      estimates,
      invoices,
      reviews,
      voiceCalls,
      salesCalls,
      surveyResponses,
      opportunities,
    ] = await Promise.all([
      this.prisma.consentRecord.findMany({ where: { workspaceId, leadId } }),
      this.prisma.conversation.findMany({ where: { workspaceId, leadId } }),
      this.prisma.booking.findMany({ where: { workspaceId, leadId } }),
      this.prisma.document.findMany({ where: { workspaceId, leadId } }),
      this.prisma.estimate.findMany({ where: { workspaceId, leadId } }),
      this.prisma.invoice.findMany({ where: { workspaceId, leadId } }),
      this.prisma.review.findMany({ where: { workspaceId, leadId } }),
      this.prisma.voiceCall.findMany({ where: { workspaceId, leadId } }),
      this.prisma.salesCall.findMany({ where: { workspaceId, leadId } }),
      this.prisma.surveyResponse.findMany({ where: { workspaceId, leadId } }),
      this.prisma.opportunity.findMany({ where: { workspaceId, leadId } }),
    ]);

    // Messages carry no leadId of their own — they belong to the subject's
    // conversations, so scope them by those conversation ids (within the ws).
    const messages = conversations.length
      ? await this.prisma.message.findMany({
          where: { workspaceId, conversationId: { in: conversations.map((c) => c.id) } },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    // Identity, membership, billing and behavioural personal data — the remaining
    // lead-scoped categories, so the access request is genuinely complete.
    const [
      contactIdentities,
      enrollments,
      certificates,
      communityMemberships,
      earnedBadges,
      subscriptions,
      wallets,
      pointsLedger,
      customObjectLinks,
      triggerLinkClicks,
      couponRedemptions,
    ] = await Promise.all([
      this.prisma.contactIdentity.findMany({ where: { workspaceId, leadId } }),
      this.prisma.enrollment.findMany({ where: { workspaceId, leadId } }),
      this.prisma.certificate.findMany({ where: { workspaceId, leadId } }),
      // CommunityMember has no workspaceId column — scope via its community.
      this.prisma.communityMember.findMany({ where: { leadId, community: { workspaceId } } }),
      this.prisma.earnedBadge.findMany({ where: { workspaceId, leadId } }),
      this.prisma.customerSubscription.findMany({ where: { workspaceId, leadId } }),
      this.prisma.customerWallet.findMany({ where: { workspaceId, leadId } }),
      this.prisma.pointsLedger.findMany({ where: { workspaceId, leadId } }),
      this.prisma.customObjectLink.findMany({ where: { workspaceId, leadId } }),
      this.prisma.triggerLinkClick.findMany({ where: { workspaceId, leadId } }),
      this.prisma.couponRedemption.findMany({ where: { workspaceId, leadId } }),
    ]);

    // Marketing-engagement, profiling, community-authored content and the wallet
    // transaction ledger — the last lead-scoped personal-data categories (Art. 15
    // requires ALL of it, not just the lead's identity + current balances). The
    // wallet ledger has no leadId, so scope it via the subject's wallet ids.
    const walletIds = wallets.map((w) => w.id);
    const [campaignRecipients, tags, communityPosts, communityComments, walletLedgerEntries] =
      await Promise.all([
        this.prisma.campaignRecipient.findMany({ where: { workspaceId, leadId } }),
        // LeadTag has no workspaceId column — keyed by the workspace-resolved lead.
        this.prisma.leadTag.findMany({ where: { leadId }, include: { tag: true } }),
        this.prisma.communityPost.findMany({ where: { workspaceId, authorLeadId: leadId } }),
        this.prisma.communityComment.findMany({ where: { workspaceId, authorLeadId: leadId } }),
        walletIds.length
          ? this.prisma.walletLedgerEntry.findMany({ where: { workspaceId, walletId: { in: walletIds } } })
          : Promise.resolve([] as unknown[]),
      ]);

    // What Art. 15 still did not answer: which automation ran against them,
    // what was drafted about them, where their record came from, which
    // duplicates were folded into it, and — for the campaign mail already
    // exported as bare recipient rows — what that mail actually SAID
    // (`dsar-export-incomplete`).
    const campaignIds = [...new Set(campaignRecipients.map((r) => r.campaignId))];
    const [
      attribution,
      workflowRuns,
      distributionDrafts,
      importJobRows,
      researchCandidates,
      mergedDuplicates,
      campaigns,
    ] = await Promise.all([
      // LeadAttribution is @unique on leadId — a 1:1 read, not a list.
      this.prisma.leadAttribution.findUnique({ where: { leadId } }),
      this.prisma.workflowRun.findMany({ where: { workspaceId, leadId } }),
      this.prisma.distributionDraft.findMany({ where: { workspaceId, leadId } }),
      // ImportJobRow has NO workspaceId column — scoped through its job, the
      // same way CommunityMember is scoped through its community above.
      this.prisma.importJobRow.findMany({ where: { leadId, job: { workspaceId } } }),
      this.prisma.researchCandidate.findMany({ where: { workspaceId, leadId } }),
      this.mergedDuplicates(workspaceId, leadId),
      campaignIds.length
        ? this.prisma.campaign.findMany({
            where: { workspaceId, id: { in: campaignIds } },
            select: { id: true, name: true, channel: true, subject: true, body: true, bodyHtml: true, createdAt: true },
          })
        : Promise.resolve([] as unknown[]),
    ]);

    // The per-step trail hangs off the runs, like messages off conversations.
    const runIds = workflowRuns.map((r) => r.id);
    const workflowStepRuns = runIds.length
      ? await this.prisma.workflowStepRun.findMany({ where: { workspaceId, runId: { in: runIds } } })
      : [];

    const payload = {
      lead,
      consents,
      conversations,
      messages,
      bookings,
      documents,
      estimates,
      invoices,
      reviews,
      voiceCalls,
      salesCalls,
      surveyResponses,
      opportunities,
      contactIdentities,
      enrollments,
      certificates,
      communityMemberships,
      earnedBadges,
      subscriptions,
      wallets,
      pointsLedger,
      customObjectLinks,
      triggerLinkClicks,
      couponRedemptions,
      campaignRecipients,
      tags,
      communityPosts,
      communityComments,
      walletLedgerEntries,
      attribution,
      workflowRuns,
      workflowStepRuns,
      distributionDrafts,
      importJobRows,
      researchCandidates,
      mergedDuplicates,
      campaigns,
    };
    await this.prisma.dataRequest.create({
      data: {
        workspaceId,
        leadId,
        kind: 'EXPORT',
        status: 'COMPLETED',
        payload: payload as unknown as Prisma.InputJsonValue,
        requestedById: requestedById ?? null,
        completedAt: new Date(),
      },
    });
    await this.retireOldExportPayloads(workspaceId);
    return payload;
  }

  /**
   * The duplicates folded INTO this subject, transitively.
   *
   * Merges chain (`lead-dedupe.service.ts` excludes an already-tombstoned lead
   * from a new merge), so a row merged into B that was later merged into C
   * still points at B — reading one level would answer the access request
   * without the grandchildren.
   */
  private async mergedDuplicates(workspaceId: string, leadId: string) {
    const out: Lead[] = [];
    const seen = new Set([leadId]);
    let frontier = [leadId];
    for (let hop = 0; hop < MERGE_CHAIN_MAX_HOPS && frontier.length; hop++) {
      const merged = await this.prisma.lead.findMany({
        where: { workspaceId, mergedIntoId: { in: frontier } },
      });
      const fresh = merged.filter((l) => !seen.has(l.id));
      for (const l of fresh) seen.add(l.id);
      out.push(...fresh);
      frontier = fresh.map((l) => l.id);
    }
    return out;
  }

  /**
   * Retire export bodies past the TTL (`export-stored-forever`).
   *
   * Opportunistic rather than scheduled: the workspace that just took an export
   * is exactly the workspace whose older ones are due, and this keeps the
   * guarantee inside the service that made the promise instead of depending on
   * a cron being armed. The audit row survives — only the payload goes, the
   * same scrub `fulfillErasure` already performs for the same reason.
   *
   * Best-effort on purpose: an export that a housekeeping sweep could fail is
   * a data-subject right denied for an operational reason.
   */
  private async retireOldExportPayloads(workspaceId: string): Promise<void> {
    const cutoff = new Date(Date.now() - EXPORT_PAYLOAD_TTL_DAYS * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.dataRequest.updateMany({
        where: { workspaceId, kind: 'EXPORT', requestedAt: { lt: cutoff } },
        data: { payload: Prisma.JsonNull },
      });
      if (count) this.logger.log(`retired ${count} export payload(s) past ${EXPORT_PAYLOAD_TTL_DAYS}d in ws=${workspaceId}`);
    } catch (e: any) {
      this.logger.warn(`export payload TTL sweep failed for ws=${workspaceId}: ${e?.message ?? e}`);
    }
  }

  async requestErasure(workspaceId: string, leadId: string, requestedById?: string) {
    await this.assertLead(workspaceId, leadId);
    return this.prisma.dataRequest.create({
      data: { workspaceId, leadId, kind: 'ERASURE', status: 'PENDING', requestedById: requestedById ?? null },
    });
  }

  /**
   * Fulfil a PENDING ERASURE request (KVKK / GDPR Art. 17, right to erasure).
   * Manager-gated at the controller. The approach is ANONYMISE-in-place, NOT a
   * hard delete: Turkish tax law mandates ~10-year retention of invoices, so
   * financial + membership records are KEPT (they simply come to reference an
   * anonymised, PII-scrubbed lead), while the subject's pure communication /
   * behavioural / identity data is DELETED and the lead's own PII is scrubbed.
   * The COMPLETED DataRequest row (kind ERASURE + leadId + completedAt) is the
   * audit trail proving the erasure ran. Idempotent by precondition: a request
   * that isn't a live PENDING ERASURE is rejected, so a double-fulfil can't
   * re-run (or re-scrub an already-anonymised lead).
   *
   * The SUBJECT is the whole merge chain, not the one row the request names
   * (`erasure-one-row`), and the addresses are read BEFORE the scrub so an
   * ERASURE tombstone can outlive them (`erasure-no-suppression`) — the person
   * has to stay unmailable without us keeping what they asked us to forget.
   *
   * Tiers (each explicitly workspace+lead scoped):
   *  - DELETE (no retention value): conversations + their messages, lead
   *    activities, voice/sales calls, contact identities, first-touch
   *    attribution, tracked link clicks, survey responses, workflow step runs.
   *  - SCRUB in place (retained rows that embed PII): bookings (attendee
   *    name/contact/notes), research candidates, import rows, distribution
   *    drafts, campaign-recipient errors, workflow-run context — see
   *    `scrubResidualPii` for why each row must survive its own scrub.
   *  - RETAIN untouched (legal retention + memberships — now pointing at the
   *    anonymised lead): invoices, estimates, commissions, wallet + ledger,
   *    subscriptions, coupon redemptions, points, opportunities, enrolments,
   *    certificates, tags, badges, community records, custom-object links,
   *    campaign recipients, consent records.
   */
  async fulfillErasure(workspaceId: string, requestId: string, actorId?: string) {
    const req = await this.prisma.dataRequest.findFirst({
      where: { id: requestId, workspaceId, kind: 'ERASURE' },
    });
    if (!req) throw new NotFoundException('Erasure request not found');
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Erasure request is already completed');
    }
    const leadId = req.leadId;

    const ran = await this.prisma.$transaction(async (tx) => {
      // Atomic claim: the FIRST fulfil flips PENDING→COMPLETED and proceeds; a
      // racing double-click (two managers, or a double-submit) sees count 0 and
      // skips — the erasure already ran in the sibling tx. Same claim-then-act
      // idiom as coupon.redeem / invoice.settle. If the erasure below throws, the
      // whole tx (claim included) rolls back, so the request stays PENDING and is
      // retryable.
      const claim = await tx.dataRequest.updateMany({
        where: { id: req.id, workspaceId, status: 'PENDING' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (claim.count === 0) return false;

      // A merge only sets `mergedIntoId`; it never scrubs the row it folded
      // away. Every id in that chain is the SAME person — the merge already
      // asserted it — so the erasure covers all of them, or the duplicate
      // stays readable through `GET /leads/:id` and mailable by the next
      // campaign (`erasure-one-row`).
      const subjectIds = await this.resolveSubjectIds(tx, workspaceId, leadId);
      const subjects = { in: subjectIds };

      // The LAST moment the addresses still exist. `fulfillErasure` is handed
      // a leadId and nothing else, so without this read the scrub below
      // destroys the only copy of the one thing a tombstone needs.
      await this.writeErasureTombstones(tx, workspaceId, subjectIds, req.id);

      // Messages carry no leadId of their own — they belong to the subject's
      // conversations, so delete them by those conversation ids before the
      // conversations themselves.
      const convos = await tx.conversation.findMany({
        where: { workspaceId, leadId: subjects },
        select: { id: true },
      });
      const convoIds = convos.map((c) => c.id);
      if (convoIds.length) {
        await tx.message.deleteMany({ where: { workspaceId, conversationId: { in: convoIds } } });
      }
      await tx.conversation.deleteMany({ where: { workspaceId, leadId: subjects } });

      // The remaining pure communication / behavioural / identity PII.
      // (LeadActivity has no workspaceId column — leadId, resolved from the
      // workspace-scoped request above, already binds it to this tenant.)
      await tx.leadActivity.deleteMany({ where: { leadId: subjects } });
      await tx.voiceCall.deleteMany({ where: { workspaceId, leadId: subjects } });
      await tx.salesCall.deleteMany({ where: { workspaceId, leadId: subjects } });
      await tx.contactIdentity.deleteMany({ where: { workspaceId, leadId: subjects } });
      await tx.leadAttribution.deleteMany({ where: { workspaceId, leadId: subjects } });
      await tx.triggerLinkClick.deleteMany({ where: { workspaceId, leadId: subjects } });
      await tx.surveyResponse.deleteMany({ where: { workspaceId, leadId: subjects } });

      await this.scrubResidualPii(tx, workspaceId, subjects);

      // Scrub PII off retained bookings (kept for the operator's calendar history).
      await tx.booking.updateMany({
        where: { workspaceId, leadId: subjects },
        data: { name: ERASED_MARKER, email: null, phone: null, notes: null },
      });

      // Anonymise the lead itself: scrub every PII field, suppress all future
      // contact, and hide it (deletedAt). Retained financial/membership rows keep
      // referencing this now-anonymised row, so referential integrity holds.
      // `mergedIntoId` is left alone: the chain is still how an old link
      // resolves to the canonical, and every row in it is now anonymised.
      await tx.lead.updateMany({
        where: { id: subjects, workspaceId },
        data: {
          businessName: ERASED_MARKER,
          contactPerson: ERASED_MARKER,
          phone: null,
          whatsapp: null,
          email: null,
          address: null,
          city: null,
          region: null,
          notes: null,
          customFields: {} as Prisma.InputJsonValue,
          phoneNormalized: null,
          emailNormalized: null,
          emailOptOut: true,
          smsOptOut: true,
          waOptOut: true,
          deletedAt: new Date(),
        },
      });

      // A prior EXPORT DataRequest snapshotted the subject's FULL PII into
      // DataRequest.payload (a durable Json blob, re-served by listRequests).
      // Erasure must scrub those bodies too — otherwise a complete plaintext copy
      // of the "erased" subject survives, defeating KVKK/GDPR Art.17. Keep the
      // audit rows (kind/leadId/completedAt), drop only the PII payload.
      await tx.dataRequest.updateMany({
        where: { workspaceId, leadId: subjects, kind: 'EXPORT' },
        data: { payload: Prisma.JsonNull },
      });

      return true;
    });

    this.logger.log(
      ran
        ? `erasure fulfilled for lead=${leadId} (request ${req.id}, by ${actorId ?? 'system'})`
        : `erasure already fulfilled for request ${req.id} — skipped (concurrent)`,
    );
    return { id: req.id, status: 'COMPLETED', leadId };
  }

  /**
   * Every lead id that IS this person: the named row plus the tombstone chain
   * merged into it, followed transitively.
   *
   * One level is not enough. `lead-dedupe.service.ts` refuses only a canonical
   * that is *currently* merged, so A→B and, later, B→C is a legal pair of
   * merges and leaves C's PII two hops from the id the request names.
   *
   * Same-address duplicates that were never merged are deliberately NOT
   * included: nothing has asserted they are the same human, and auto-scrubbing
   * a stranger who shares `info@` with the subject would be its own breach.
   * They are covered instead by the ERASURE tombstone, which is keyed on the
   * address rather than on the row.
   */
  private async resolveSubjectIds(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    leadId: string,
  ): Promise<string[]> {
    const ids = [leadId];
    let frontier = [leadId];
    for (let hop = 0; hop < MERGE_CHAIN_MAX_HOPS && frontier.length; hop++) {
      const merged = await tx.lead.findMany({
        where: { workspaceId, mergedIntoId: { in: frontier } },
        select: { id: true },
      });
      // Filtering against what we have already seen is what makes a cycle
      // terminate rather than spin until the hop cap.
      frontier = merged.map((m) => m.id).filter((id) => !ids.includes(id));
      ids.push(...frontier);
    }
    if (frontier.length) {
      this.logger.warn(`Merge chain for lead=${leadId} exceeded ${MERGE_CHAIN_MAX_HOPS} hops — erasure may be partial`);
    }
    return ids;
  }

  /**
   * The tombstone that makes an erased person unmailable WITHOUT keeping their
   * address (§A3.6, R4).
   *
   * Erasure nulls `emailNormalized`/`phoneNormalized`, which are the only keys
   * every create path dedupes on — so today the same person walks back in
   * through an import, a form or their next inbound mail as a brand-new,
   * opted-IN lead, and the AI or a campaign mails someone who asked to be
   * forgotten (`erasure-no-suppression`).
   *
   * `SuppressionService` stores an HMAC of the value, never the value, so the
   * tombstone answers "is this address erased?" without being a readable copy
   * of the person we just erased. PHONE is written too: SMS/WhatsApp have the
   * identical hole, and İYS only covers someone who previously opted out, not
   * someone merely erased.
   */
  private async writeErasureTombstones(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    subjectIds: string[],
    requestId: string,
  ): Promise<void> {
    const subjects = await tx.lead.findMany({
      where: { workspaceId, id: { in: subjectIds } },
      select: { emailNormalized: true, phoneNormalized: true },
    });
    const source = `erasure:${requestId}`;
    const emails = new Set(subjects.map((s) => s.emailNormalized).filter((v): v is string => !!v));
    const phones = new Set(subjects.map((s) => s.phoneNormalized).filter((v): v is string => !!v));
    for (const email of emails) {
      await this.suppression.suppress(workspaceId, email, 'EMAIL', 'ERASURE', { source, tx });
    }
    for (const phone of phones) {
      await this.suppression.suppress(workspaceId, phone, 'PHONE', 'ERASURE', { source, tx });
    }
  }

  /**
   * The PII a "permanent deletion" used to leave behind (`erasure-residual-pii`):
   * the address in the row that created the lead, the body of a draft written
   * about them, the trigger payload a workflow run is still carrying.
   *
   * Every one of these is SCRUBBED, never deleted, and each for its own
   * sibling-breaking reason:
   *  - `ResearchCandidate` — its `@@unique([workspaceId, profileId, externalRef])`
   *    is the ONLY thing stopping the next research run re-ingesting the same
   *    prospect, and the lead's own dedupe keys are about to be nulled. A
   *    delete here literally recreates the person we are erasing.
   *  - `ImportJobRow` — `processBatch` counts remaining work by row status;
   *    deleting rows corrupts a running import's progress. No `workspaceId`
   *    column, so it is scoped through its job.
   *  - `DistributionDraft` — `@@unique([planId, leadId, channelType])` is the
   *    anti-restack guard, and a Postgres CHECK requires a SENT row to keep
   *    `sentById`. Drafts still inviting a send are dismissed as well, so
   *    nobody is offered a "send" against a contact who is gone.
   *  - `CampaignRecipient` — the row is retained on purpose for campaign stats;
   *    only the free-text provider line carries the subject's words.
   *  - `WorkflowRun` — the run row is what lets `workflow-executor` STOP a
   *    WAITING run of a deleted lead on resume. Its `context` (the trigger
   *    payload) and `lastError` are the PII; the step trail is deleted outright.
   */
  private async scrubResidualPii(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    subjects: { in: string[] },
  ): Promise<void> {
    await tx.researchCandidate.updateMany({
      where: { workspaceId, leadId: subjects },
      data: {
        businessName: ERASED_MARKER,
        email: null,
        phone: null,
        instagram: null,
        website: null,
        painPoint: '',
        evidence: '',
        pitch: '',
      },
    });

    await tx.importJobRow.updateMany({
      where: { leadId: subjects, job: { workspaceId } },
      data: { raw: {} as Prisma.InputJsonValue, error: null },
    });

    await tx.distributionDraft.updateMany({
      where: { workspaceId, leadId: subjects },
      data: { toAddress: ERASED_MARKER, body: '', error: null },
    });
    await tx.distributionDraft.updateMany({
      where: { workspaceId, leadId: subjects, status: 'DRAFT' },
      data: { status: 'DISMISSED' },
    });

    await tx.campaignRecipient.updateMany({
      where: { workspaceId, leadId: subjects },
      data: { error: null },
    });

    const runs = await tx.workflowRun.findMany({
      where: { workspaceId, leadId: subjects },
      select: { id: true },
    });
    await tx.workflowRun.updateMany({
      where: { workspaceId, leadId: subjects },
      data: { context: {} as Prisma.InputJsonValue, lastError: null },
    });
    if (runs.length) {
      await tx.workflowStepRun.deleteMany({
        where: { workspaceId, runId: { in: runs.map((r) => r.id) } },
      });
    }
  }

  /**
   * The request history — WITHOUT the bodies (`export-stored-forever`).
   *
   * `DataRequest.payload` is a full plaintext snapshot of one subject, and this
   * list was handing 100 of them to anyone who could open the Compliance tab.
   * The select mirrors the frontend's own `DataRequest` interface
   * (pages/marketing/settings/compliance/types.ts), which never asked for more.
   */
  listRequests(workspaceId: string) {
    return this.prisma.dataRequest.findMany({
      where: { workspaceId },
      select: {
        id: true,
        leadId: true,
        kind: true,
        status: true,
        requestedAt: true,
        completedAt: true,
        requestedById: true,
      },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    });
  }

  /** Manager-triggered reset for the İYS auto-push DLQ (Phase 2 Task 3):
   *  DLQ → PENDING, attempts=0, scoped to the caller's workspace. */
  retryIys(workspaceId: string) {
    return this.iysSync.retryDlq(workspaceId);
  }

  /** Read-only DLQ count (Phase 2 Task 6) — drives the SMS channel card's
   *  warning badge + retry action, scoped to the caller's workspace. */
  iysDlqCount(workspaceId: string) {
    return this.iysSync.dlqCount(workspaceId);
  }
}
