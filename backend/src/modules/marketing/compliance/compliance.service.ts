import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes, MarketingSmsOptStatusPayload } from '../events/marketing-event-types';

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
    const record = await this.prisma.consentRecord.create({
      data: { workspaceId, leadId, type, granted, source: meta.source, ipAddress: meta.ipAddress },
    });
    const field = OPT_OUT_FIELD[type];
    if (field) {
      // granted=false → opted OUT (true); granted=true → opted IN (false).
      await this.prisma.lead.update({ where: { id: leadId }, data: { [field]: !granted } });
      if (field === 'smsOptOut') {
        await this.emitSmsOptEvent(workspaceId, leadId, granted, record.id);
      }
    }
    return record;
  }

  /**
   * Mirrors an SMS opt-out/opt-in transition to NetgsmBlacklistSyncService via
   * the outbox (defense-in-depth NetGSM account-blacklist sync — see that
   * service's docstring). Best-effort: the consent itself is already durably
   * recorded above, so a failure enqueueing the follow-on sync event is
   * logged rather than failing the whole request.
   */
  private async emitSmsOptEvent(
    workspaceId: string,
    leadId: string,
    granted: boolean,
    consentRecordId: string,
  ): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
    if (!lead?.phone) return; // nothing to sync without a phone number
    const eventType = granted ? MarketingEventTypes.SmsOptedIn : MarketingEventTypes.SmsOptedOut;
    try {
      await this.outbox.append({
        type: eventType,
        tenantId: null,
        payload: { workspaceId, leadId, phone: lead.phone } satisfies MarketingSmsOptStatusPayload,
        idempotencyKey: `${workspaceId}:${leadId}:${eventType}:consent:${consentRecordId}`,
      });
    } catch (e: any) {
      this.logger.warn(`Failed to enqueue ${eventType} for lead=${leadId}: ${e?.message ?? e}`);
    }
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

  listRequests(workspaceId: string) {
    return this.prisma.dataRequest.findMany({
      where: { workspaceId },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    });
  }
}
