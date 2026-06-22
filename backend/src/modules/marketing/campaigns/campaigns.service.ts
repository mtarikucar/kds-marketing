import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

export const CAMPAIGN_BATCH_KIND = 'campaign.batch';

// Audience filters may only target these scalar lead columns (no arbitrary
// Prisma path injection).
const LEAD_FILTER_FIELDS = new Set([
  'status', 'city', 'region', 'businessType', 'priority', 'source', 'businessName',
]);

interface AudienceFilter {
  field: string;
  op: string;
  value?: any;
}

/**
 * Campaign CRUD + launch. Launch freezes the audience (leads matching the
 * filter AND opted-in AND reachable on the channel) into CampaignRecipient
 * rows, extracts the body's links for safe click-tracking, flips the campaign
 * to SENDING and kicks the first throttled `campaign.batch` job.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.campaign.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, channel: true, status: true, scheduledAt: true, stats: true, updatedAt: true },
    });
  }

  async get(workspaceId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async create(workspaceId: string, dto: { name: string; channel: string; subject?: string; body: string; bodyHtml?: string; emailTemplateId?: string; audienceFilter?: unknown; scheduledAt?: string }) {
    if (!['EMAIL', 'SMS', 'WHATSAPP'].includes(dto.channel)) {
      throw new BadRequestException('Invalid channel');
    }
    return this.prisma.campaign.create({
      data: {
        workspaceId,
        name: dto.name,
        channel: dto.channel,
        subject: dto.subject ?? null,
        body: dto.body,
        bodyHtml: dto.bodyHtml || null,
        emailTemplateId: dto.emailTemplateId || null,
        audienceFilter: (dto.audienceFilter ?? []) as Prisma.InputJsonValue,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        status: 'DRAFT',
      },
    });
  }

  async update(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Campaign not found');
    if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') {
      throw new BadRequestException('Only a draft/scheduled campaign can be edited');
    }
    const data: any = {};
    for (const k of ['name', 'subject', 'body', 'bodyHtml', 'emailTemplateId'] as const) if (dto[k] !== undefined) data[k] = dto[k];
    // An explicit '' for the HTML fields means "revert to plain text" → clear them.
    if (data.bodyHtml === '') data.bodyHtml = null;
    if (data.emailTemplateId === '') data.emailTemplateId = null;
    if (dto.audienceFilter !== undefined) data.audienceFilter = dto.audienceFilter;
    if (dto.scheduledAt !== undefined) data.scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    return this.prisma.campaign.update({ where: { id: existing.id }, data });
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.campaign.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Campaign not found');
    return { message: 'Campaign deleted' };
  }

  async pause(workspaceId: string, id: string) {
    await this.scopedStatus(workspaceId, id, 'SENDING', 'PAUSED');
    return { message: 'Campaign paused' };
  }

  async resume(workspaceId: string, id: string) {
    const c = await this.scopedStatus(workspaceId, id, 'PAUSED', 'SENDING');
    await this.kickBatch(workspaceId, c.id);
    return { message: 'Campaign resumed' };
  }

  async cancel(workspaceId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!c) throw new NotFoundException('Campaign not found');
    await this.scheduledJobs.cancel(CAMPAIGN_BATCH_KIND, c.id);
    await this.prisma.campaign.update({ where: { id: c.id }, data: { status: 'CANCELLED' } });
    return { message: 'Campaign cancelled' };
  }

  async recipients(workspaceId: string, id: string) {
    return this.prisma.campaignRecipient.findMany({
      where: { workspaceId, campaignId: id },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: { id: true, leadId: true, status: true, sentAt: true, openedAt: true, clickedAt: true, error: true },
    });
  }

  /** Freeze the audience, extract links, flip to SENDING, kick the first batch. */
  async launch(workspaceId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== 'DRAFT' && campaign.status !== 'SCHEDULED') {
      throw new BadRequestException('Campaign already launched');
    }
    const where = this.buildAudienceWhere(workspaceId, campaign.channel, campaign.audienceFilter);
    const leads = await this.prisma.lead.findMany({ where: { ...where, workspaceId }, select: { id: true } });
    if (leads.length === 0) throw new BadRequestException('Audience is empty (no opted-in, reachable leads match)');

    // Track links from the plain-text body AND the HTML body (decoded first, so a
    // tracked link's redirect target is the real URL, not an HTML-escaped one).
    const links = [
      ...new Set([
        ...this.extractLinks(campaign.body),
        ...this.extractLinks(this.decodeHtml((campaign as any).bodyHtml ?? '')),
      ]),
    ];
    // Materialize recipients (skip dupes if a previous partial launch raced).
    await this.prisma.campaignRecipient.createMany({
      data: leads.map((l) => ({
        workspaceId,
        campaignId: campaign.id,
        leadId: l.id,
        token: `cr_${randomBytes(18).toString('hex')}`,
      })),
      skipDuplicates: true,
    });
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: 'SENDING',
        startedAt: new Date(),
        links: links as Prisma.InputJsonValue,
        stats: { recipients: leads.length, sent: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, unsubscribed: 0 },
      },
    });
    await this.kickBatch(workspaceId, campaign.id);
    return { message: 'Campaign launched', recipients: leads.length };
  }

  private async kickBatch(workspaceId: string, campaignId: string) {
    await this.scheduledJobs.schedule({
      workspaceId,
      kind: CAMPAIGN_BATCH_KIND,
      runAt: new Date(),
      dedupKey: campaignId,
      payload: { workspaceId, campaignId },
    });
  }

  private async scopedStatus(workspaceId: string, id: string, from: string, to: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (c.status !== from) throw new BadRequestException(`Campaign is not ${from}`);
    return this.prisma.campaign.update({ where: { id: c.id }, data: { status: to } });
  }

  /** Build a tenant-scoped, opt-in, reachable Prisma where from the filter DSL. */
  buildAudienceWhere(workspaceId: string, channel: string, audienceFilter: unknown): Prisma.LeadWhereInput {
    // Tombstoned (merged) and soft-deleted leads must never become recipients.
    const where: any = { workspaceId, mergedIntoId: null, deletedAt: null };
    if (channel === 'EMAIL') { where.emailOptOut = false; where.email = { not: null }; }
    else if (channel === 'SMS') { where.smsOptOut = false; where.phone = { not: null }; }
    else if (channel === 'WHATSAPP') { where.waOptOut = false; where.OR = [{ whatsapp: { not: null } }, { phone: { not: null } }]; }

    const filters = Array.isArray(audienceFilter) ? (audienceFilter as AudienceFilter[]) : [];
    for (const f of filters) {
      const field = f.field?.replace(/^lead\./, '');
      if (!field || !LEAD_FILTER_FIELDS.has(field)) continue;
      switch (f.op) {
        case 'eq': where[field] = f.value; break;
        case 'neq': where[field] = { not: f.value }; break;
        case 'in': if (Array.isArray(f.value)) where[field] = { in: f.value }; break;
        case 'contains': where[field] = { contains: String(f.value), mode: 'insensitive' }; break;
        case 'gte': where[field] = { gte: f.value }; break;
        case 'lte': where[field] = { lte: f.value }; break;
        case 'exists': where[field] = f.value ? { not: null } : null; break;
      }
    }
    return where as Prisma.LeadWhereInput;
  }

  private extractLinks(body: string): string[] {
    const urls = body.match(/https?:\/\/[^\s)\]<>"']+/g) ?? [];
    return [...new Set(urls)];
  }

  /** Reverse the renderer's HTML escaping so URLs extracted from compiled email
   *  HTML are the real targets (&amp;→& etc.). &amp; is decoded last to avoid
   *  double-decoding (e.g. "&amp;lt;" → "&lt;", not "<"). */
  private decodeHtml(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
}
