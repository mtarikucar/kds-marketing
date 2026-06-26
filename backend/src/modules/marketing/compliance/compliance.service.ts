import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

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
  constructor(private prisma: PrismaService) {}

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
    }
    return record;
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
