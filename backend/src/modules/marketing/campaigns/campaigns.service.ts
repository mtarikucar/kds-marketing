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
/** A/B WINNER mode: the job that picks the winner + releases the held remainder. */
export const CAMPAIGN_AB_DECIDE_KIND = 'campaign.ab.decide';
/** How long the test cohort runs before the winner is auto-decided. */
export const AB_TEST_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h

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
    const variants = await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId: id }, orderBy: { key: 'asc' } });
    return { ...c, variants };
  }

  async getVariants(workspaceId: string, campaignId: string) {
    return this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId }, orderBy: { key: 'asc' } });
  }

  /** Replace a campaign's A/B variants (GHL parity). Only on a draft/scheduled
   *  campaign — the recipient split is frozen at launch. abEnabled is forced off
   *  unless there are at least two variants to split between. */
  async setVariants(
    workspaceId: string,
    campaignId: string,
    dto: {
      abEnabled?: boolean;
      abMode?: 'SPLIT' | 'WINNER';
      abTestPercent?: number;
      abWinnerMetric?: 'OPEN' | 'CLICK';
      variants: Array<{ key: string; weight?: number; subject?: string; body: string; bodyHtml?: string; emailTemplateId?: string }>;
    },
  ) {
    const c = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId }, select: { id: true, status: true } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (c.status !== 'DRAFT' && c.status !== 'SCHEDULED') {
      throw new BadRequestException('Only a draft/scheduled campaign can be edited');
    }
    const keys = new Set<string>();
    for (const v of dto.variants) {
      const key = (v.key ?? '').trim();
      if (!key || keys.has(key)) throw new BadRequestException('Variant keys must be unique and non-empty');
      keys.add(key);
      if ((v.weight ?? 1) < 1 || (v.weight ?? 1) > 1000) throw new BadRequestException('Variant weight must be 1–1000');
    }
    const abEnabled = !!dto.abEnabled && dto.variants.length > 1;
    const winner = abEnabled && dto.abMode === 'WINNER';
    // WINNER mode: test cohort is 5–50% of the audience; default 20% / pick by opens.
    const abMode = abEnabled ? (winner ? 'WINNER' : 'SPLIT') : null;
    const abTestPercent = winner ? Math.min(50, Math.max(5, Math.round(dto.abTestPercent ?? 20))) : null;
    const abWinnerMetric = winner ? (dto.abWinnerMetric === 'CLICK' ? 'CLICK' : 'OPEN') : null;
    await this.prisma.$transaction([
      this.prisma.campaignVariant.deleteMany({ where: { campaignId, workspaceId } }),
      ...(dto.variants.length
        ? [this.prisma.campaignVariant.createMany({
            data: dto.variants.map((v) => ({
              workspaceId,
              campaignId,
              key: v.key.trim(),
              weight: v.weight ?? 1,
              subject: v.subject ?? null,
              body: v.body,
              bodyHtml: v.bodyHtml || null,
              emailTemplateId: v.emailTemplateId || null,
            })),
          })]
        : []),
      this.prisma.campaign.updateMany({
        where: { id: campaignId, workspaceId },
        data: { abEnabled, abMode, abTestPercent, abWinnerMetric, abWinnerKey: null, abDecideAt: null },
      }),
    ]);
    return this.getVariants(workspaceId, campaignId);
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

    // A/B: split recipients across variants by weight (frozen here at launch).
    const variants = (campaign as any).abEnabled
      ? await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId: campaign.id } })
      : [];
    const useAb = variants.length > 1;

    // Track links from the control body+HTML AND every variant body+HTML (decoded
    // first, so a tracked link's redirect target is the real URL, not escaped).
    const srcs = [campaign.body, this.decodeHtml((campaign as any).bodyHtml ?? '')];
    for (const v of variants) srcs.push(v.body, this.decodeHtml(v.bodyHtml ?? ''));
    const links = [...new Set(srcs.flatMap((s) => this.extractLinks(s)))];

    // WINNER mode: only abTestPercent% of the audience is the test cohort (sent
    // now across variants); the remainder is HELD until the winner is decided.
    const winnerMode = useAb && (campaign as any).abMode === 'WINNER';
    let testLeads = leads;
    let holdLeads: typeof leads = [];
    let abDecideAt: Date | null = null;
    if (winnerMode) {
      const shuffled = [...leads].sort(() => Math.random() - 0.5);
      const pct = (campaign as any).abTestPercent ?? 20;
      // hold back at least 1; test at least one per variant
      const testCount = Math.max(variants.length, Math.min(Math.ceil((leads.length * pct) / 100), leads.length - 1));
      testLeads = shuffled.slice(0, testCount);
      holdLeads = shuffled.slice(testCount);
      abDecideAt = new Date(Date.now() + AB_TEST_WINDOW_MS);
    }

    // Materialize recipients (skip dupes if a previous partial launch raced).
    const tok = () => `cr_${randomBytes(18).toString('hex')}`;
    await this.prisma.campaignRecipient.createMany({
      data: [
        ...testLeads.map((l) => ({
          workspaceId, campaignId: campaign.id, leadId: l.id, token: tok(),
          variantKey: useAb ? this.pickVariant(variants) : null,
        })),
        ...holdLeads.map((l) => ({
          workspaceId, campaignId: campaign.id, leadId: l.id, token: tok(),
          variantKey: null, status: 'HOLD', // released to PENDING when the winner is picked
        })),
      ],
      skipDuplicates: true,
    });
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: 'SENDING',
        startedAt: new Date(),
        ...(abDecideAt ? { abDecideAt } : {}),
        links: links as Prisma.InputJsonValue,
        stats: { recipients: leads.length, sent: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, unsubscribed: 0 },
      },
    });
    if (winnerMode && abDecideAt) {
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CAMPAIGN_AB_DECIDE_KIND,
        runAt: abDecideAt,
        dedupKey: `ab-decide:${campaign.id}`,
        payload: { workspaceId, campaignId: campaign.id },
      });
    }
    await this.kickBatch(workspaceId, campaign.id);
    return { message: 'Campaign launched', recipients: leads.length, testCohort: winnerMode ? testLeads.length : undefined };
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
    // Epic 9a — exclude syntactically/MX-INVALID and hard-bounced emails so a
    // campaign never burns sender reputation on an address that can't receive.
    if (channel === 'EMAIL') {
      where.emailOptOut = false;
      where.email = { not: null };
      where.emailBouncedAt = null;
      where.emailVerifiedStatus = { not: 'INVALID' };
    }
    else if (channel === 'SMS') { where.smsOptOut = false; where.phone = { not: null }; }
    else if (channel === 'WHATSAPP') { where.waOptOut = false; where.OR = [{ whatsapp: { not: null } }, { phone: { not: null } }]; }

    const filters = Array.isArray(audienceFilter) ? (audienceFilter as AudienceFilter[]) : [];
    for (const f of filters) {
      const field = f.field?.replace(/^lead\./, '');
      if (!field || !LEAD_FILTER_FIELDS.has(field)) continue;
      // A scalar op needs a scalar value: an ARRAY would compile to e.g.
      // `{ status: ['a','b'] }`, an invalid Prisma filter that 500s when the
      // audience is materialized. Guard the scalar ops the same way `in` already
      // guards against a non-array — drop the malformed leaf rather than poison
      // the whole where.
      const scalar = !Array.isArray(f.value);
      switch (f.op) {
        case 'eq': if (scalar) where[field] = f.value; break;
        case 'neq': if (scalar) where[field] = { not: f.value }; break;
        case 'in': if (Array.isArray(f.value)) where[field] = { in: f.value }; break;
        case 'contains': where[field] = { contains: String(f.value), mode: 'insensitive' }; break;
        case 'gte': if (scalar) where[field] = { gte: f.value }; break;
        case 'lte': if (scalar) where[field] = { lte: f.value }; break;
        case 'exists': where[field] = f.value ? { not: null } : null; break;
      }
    }
    return where as Prisma.LeadWhereInput;
  }

  /** Weighted-random pick of a variant key (split frozen per recipient at launch). */
  private pickVariant(variants: Array<{ key: string; weight: number }>): string {
    const total = variants.reduce((s, v) => s + Math.max(1, v.weight), 0);
    let r = Math.random() * total;
    for (const v of variants) {
      r -= Math.max(1, v.weight);
      if (r < 0) return v.key;
    }
    return variants[variants.length - 1].key;
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
