import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes, MarketingSmsOptStatusPayload } from '../events/marketing-event-types';
import { IysSyncService } from './iys-sync.service';

/** Placeholder written over a name once its owner has exercised erasure. */
const ERASED_MARKER = '[Silinmiş]';

const OPT_OUT_FIELD: Record<string, 'emailOptOut' | 'smsOptOut' | 'waOptOut'> = {
  MARKETING_EMAIL: 'emailOptOut',
  MARKETING_SMS: 'smsOptOut',
  MARKETING_WHATSAPP: 'waOptOut',
};

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

    const record = await this.prisma.consentRecord.create({
      data: { workspaceId, leadId, type, granted, source: meta.source, ipAddress: meta.ipAddress },
    });
    if (field) {
      // granted=false → opted OUT (true); granted=true → opted IN (false).
      await this.prisma.lead.update({ where: { id: leadId }, data: { [field]: !granted } });
    }
    return record;
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
    const latest: Record<string, { type: string; granted: boolean; at: Date }> = {};
    for (const r of all) {
      if (!(r.type in latest)) latest[r.type] = { type: r.type, granted: r.granted, at: r.createdAt };
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
    return payload;
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
   * Tiers (each explicitly workspace+lead scoped):
   *  - DELETE (no retention value): conversations + their messages, lead
   *    activities, voice/sales calls, contact identities, first-touch
   *    attribution, tracked link clicks, survey responses.
   *  - SCRUB in place (retained rows that embed PII): bookings (attendee
   *    name/contact/notes).
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

      // Messages carry no leadId of their own — they belong to the subject's
      // conversations, so delete them by those conversation ids before the
      // conversations themselves.
      const convos = await tx.conversation.findMany({
        where: { workspaceId, leadId },
        select: { id: true },
      });
      const convoIds = convos.map((c) => c.id);
      if (convoIds.length) {
        await tx.message.deleteMany({ where: { workspaceId, conversationId: { in: convoIds } } });
      }
      await tx.conversation.deleteMany({ where: { workspaceId, leadId } });

      // The remaining pure communication / behavioural / identity PII.
      // (LeadActivity has no workspaceId column — leadId, resolved from the
      // workspace-scoped request above, already binds it to this tenant.)
      await tx.leadActivity.deleteMany({ where: { leadId } });
      await tx.voiceCall.deleteMany({ where: { workspaceId, leadId } });
      await tx.salesCall.deleteMany({ where: { workspaceId, leadId } });
      await tx.contactIdentity.deleteMany({ where: { workspaceId, leadId } });
      await tx.leadAttribution.deleteMany({ where: { workspaceId, leadId } });
      await tx.triggerLinkClick.deleteMany({ where: { workspaceId, leadId } });
      await tx.surveyResponse.deleteMany({ where: { workspaceId, leadId } });

      // Scrub PII off retained bookings (kept for the operator's calendar history).
      await tx.booking.updateMany({
        where: { workspaceId, leadId },
        data: { name: ERASED_MARKER, email: null, phone: null, notes: null },
      });

      // Anonymise the lead itself: scrub every PII field, suppress all future
      // contact, and hide it (deletedAt). Retained financial/membership rows keep
      // referencing this now-anonymised row, so referential integrity holds.
      await tx.lead.updateMany({
        where: { id: leadId, workspaceId },
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

      return true;
    });

    this.logger.log(
      ran
        ? `erasure fulfilled for lead=${leadId} (request ${req.id}, by ${actorId ?? 'system'})`
        : `erasure already fulfilled for request ${req.id} — skipped (concurrent)`,
    );
    return { id: req.id, status: 'COMPLETED', leadId };
  }

  listRequests(workspaceId: string) {
    return this.prisma.dataRequest.findMany({
      where: { workspaceId },
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
