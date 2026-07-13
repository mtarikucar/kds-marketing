import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { EntitlementsService } from '../../billing/entitlements.service';

export const CAMPAIGN_BATCH_KIND = 'campaign.batch';
/** A/B WINNER mode: the job that picks the winner + releases the held remainder. */
export const CAMPAIGN_AB_DECIDE_KIND = 'campaign.ab.decide';
/** A DRAFT campaign launched with a future `scheduledAt`: the job that flips it
 *  SCHEDULED → SENDING and kicks the first batch, at `scheduledAt`. */
export const CAMPAIGN_LAUNCH_KIND = 'campaign.launch';
/** How long the test cohort runs before the winner is auto-decided. */
export const AB_TEST_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h
/** A `scheduledAt` within this window of "now" is treated as "send immediately"
 *  rather than queuing a `campaign.launch` job for a few seconds out. */
const SCHEDULE_TOLERANCE_MS = 30_000;

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
 * rows and extracts the body's links for safe click-tracking. With no future
 * `scheduledAt` it flips the campaign to SENDING and kicks the first throttled
 * `campaign.batch` job right away; with one, it flips to SCHEDULED instead and
 * queues a `campaign.launch` job for scheduledAt (campaign-sender.service.ts's
 * handler does the actual SENDING flip + batch kick when that job fires).
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly entitlements: EntitlementsService,
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

  async create(workspaceId: string, dto: { name: string; channel: string; subject?: string; body: string; bodyHtml?: string; emailTemplateId?: string; audienceFilter?: unknown; scheduledAt?: string; iysMessageType?: string; voiceConfig?: { msg?: string; audioid?: string; keys?: string[] } }) {
    if (!['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'].includes(dto.channel)) {
      throw new BadRequestException('Invalid channel');
    }
    // SMS is its own sellable feature (split off `conversationAi` for the
    // NetGSM SMS v2 program) — an SMS-channel campaign requires it even
    // though the broader `campaigns` feature already gates this controller.
    if (dto.channel === 'SMS') {
      const effective = await this.entitlements.getEffective(workspaceId);
      if (!effective.features.sms) {
        throw new ForbiddenException({
          message: 'This feature requires a higher package',
          feature: 'sms',
          code: 'FEATURE_NOT_IN_PACKAGE',
        });
      }
    }
    // VOICE campaigns (NetGSM Phase 5, `voiceCampaigns`) — same shape of gate
    // as SMS above, plus a msg-or-audioid shape check on voiceConfig (the
    // DTO only validates field TYPES, not the cross-field "at least one of
    // msg/audioid" business rule).
    if (dto.channel === 'VOICE') {
      const effective = await this.entitlements.getEffective(workspaceId);
      if (!effective.features.voiceCampaigns) {
        throw new ForbiddenException({
          message: 'This feature requires a higher package',
          feature: 'voiceCampaigns',
          code: 'FEATURE_NOT_IN_PACKAGE',
        });
      }
      this.assertVoiceConfig(dto.voiceConfig);
    }
    return this.prisma.campaign.create({
      data: {
        workspaceId,
        name: dto.name,
        channel: dto.channel,
        subject: dto.subject || null,
        body: dto.body,
        bodyHtml: dto.bodyHtml || null,
        emailTemplateId: dto.emailTemplateId || null,
        audienceFilter: (dto.audienceFilter ?? []) as Prisma.InputJsonValue,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        // İYS classification only means anything for SMS/VOICE — force it to
        // the exempt default on every other channel so a stray value never
        // silently rides along on an EMAIL/WHATSAPP campaign (the sender's
        // TİCARİ preflight only ever reads it on those two branches anyway,
        // but this keeps the stored value honest for CampaignsPage.tsx's own display).
        iysMessageType:
          (dto.channel === 'SMS' || dto.channel === 'VOICE') && dto.iysMessageType === 'TICARI'
            ? 'TICARI'
            : 'BILGILENDIRME',
        voiceConfig: dto.channel === 'VOICE' ? (dto.voiceConfig as Prisma.InputJsonValue) : Prisma.JsonNull,
        status: 'DRAFT',
      },
    });
  }

  /** Cross-field business rule the DTO's per-field decorators can't express:
   *  a VOICE campaign's voiceConfig must be present and carry msg OR audioid
   *  (NetGSM's voicesms/send accepts exactly one of them). */
  private assertVoiceConfig(voiceConfig: { msg?: string; audioid?: string } | undefined): void {
    const hasMsg = typeof voiceConfig?.msg === 'string' && voiceConfig.msg.trim().length > 0;
    const hasAudio = typeof voiceConfig?.audioid === 'string' && voiceConfig.audioid.trim().length > 0;
    if (!hasMsg && !hasAudio) {
      throw new BadRequestException('voiceConfig must include either msg (TTS text) or audioid (uploaded audio)');
    }
  }

  async update(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Campaign not found');
    if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') {
      throw new BadRequestException('Only a draft/scheduled campaign can be edited');
    }
    const data: any = {};
    for (const k of ['name', 'subject', 'body', 'bodyHtml', 'emailTemplateId'] as const) if (dto[k] !== undefined) data[k] = dto[k];
    // An explicit '' for a nullable field means "clear it" → null. Without this the
    // '' would persist (subject) or the stale HTML/template would keep shipping. The
    // sender treats a null subject as the "Update" default; an '' would send a blank
    // subject line, so subject must normalize to null on clear like its siblings.
    if (data.subject === '') data.subject = null;
    if (data.bodyHtml === '') data.bodyHtml = null;
    if (data.emailTemplateId === '') data.emailTemplateId = null;
    // Same SMS/VOICE-only normalization as create(): channel itself isn't
    // editable (not in the field loop above), so `existing.channel` is this
    // campaign's permanent channel — force the exempt default on anything else.
    if (dto.iysMessageType !== undefined) {
      data.iysMessageType =
        (existing.channel === 'SMS' || existing.channel === 'VOICE') && dto.iysMessageType === 'TICARI'
          ? 'TICARI'
          : 'BILGILENDIRME';
    }
    // voiceConfig is only editable on a VOICE campaign (mirrors channel-scoped
    // iysMessageType above) — re-validated the same way create() does, since
    // an edit could otherwise clear both msg AND audioid on a draft.
    if (dto.voiceConfig !== undefined && existing.channel === 'VOICE') {
      this.assertVoiceConfig(dto.voiceConfig);
      data.voiceConfig = dto.voiceConfig;
    }
    if (dto.audienceFilter !== undefined) data.audienceFilter = dto.audienceFilter;
    if (dto.scheduledAt !== undefined) data.scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const updated = await this.prisma.campaign.update({ where: { id: existing.id }, data });

    // A SCHEDULED campaign already has its `campaign.launch` job queued (audience
    // frozen, recipients materialized). Editing scheduledAt here must move that
    // job, not just the DB column — otherwise the stale job still fires at the
    // OLD time regardless of what the operator just picked.
    if (existing.status === 'SCHEDULED' && dto.scheduledAt !== undefined) {
      // Read the new scheduledAt from `data` (what we just asked Prisma to
      // persist) rather than `updated` — trusting the write we issued rather
      // than however a given Prisma client/mock happens to shape its return.
      const newScheduledAt: Date | null = data.scheduledAt;
      if (newScheduledAt && newScheduledAt.getTime() > Date.now() + SCHEDULE_TOLERANCE_MS) {
        // No explicit cancel first: schedule()'s dedupKey lookup collapses onto
        // the existing PENDING campaign.launch row for this campaign (it
        // UPDATEs runAt/payload in place rather than returning the stale row
        // untouched — verified in scheduled-job.service.ts), so this alone
        // moves the job to the new time.
        await this.scheduledJobs.schedule({
          workspaceId,
          kind: CAMPAIGN_LAUNCH_KIND,
          runAt: newScheduledAt,
          dedupKey: existing.id,
          payload: { workspaceId, campaignId: existing.id },
        });
      } else {
        // Cleared, or moved to a non-future time: nothing is left to fire the
        // launch — cancel the stale job and revert to DRAFT rather than
        // stranding the campaign SCHEDULED with no queued job. The frozen
        // recipients/links stay put; a later launch() re-freeze is idempotent
        // (CampaignRecipient's @@unique([campaignId, leadId]) + skipDuplicates).
        await this.scheduledJobs.cancel(CAMPAIGN_LAUNCH_KIND, existing.id);
        await this.prisma.campaign.update({ where: { id: existing.id }, data: { status: 'DRAFT' } });
        updated.status = 'DRAFT';
      }
    }
    return updated;
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

  /**
   * Cancel a SCHEDULED (not yet sending) campaign's queued send — the "undo" for
   * a scheduled blast. Only valid from SCHEDULED: a SENDING campaign must go
   * through `pause` instead (cancelling mid-send would abandon recipients in an
   * ambiguous sent/skipped limbo), and any other status (including an
   * already-CANCELLED one) has nothing queued to cancel.
   */
  async cancel(workspaceId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId }, select: { id: true, status: true } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (c.status !== 'SCHEDULED') {
      throw new ConflictException('Only a scheduled (not yet sending) campaign can be cancelled');
    }
    // Cancel whichever job is actually queued for a SCHEDULED campaign — the
    // `campaign.launch` job that would flip it to SENDING at scheduledAt. The
    // `campaign.batch` cancel alongside it is a defensive no-op (SCHEDULED never
    // has one queued; only SENDING does), kept so this stays correct even if a
    // future edge case leaves one behind.
    await this.scheduledJobs.cancel(CAMPAIGN_BATCH_KIND, c.id);
    await this.scheduledJobs.cancel(CAMPAIGN_LAUNCH_KIND, c.id);
    // NetGSM-side scheduling (startdate passthrough) isn't wired up yet — app-side
    // ScheduledJob cancellation above is the only queued work today. If a later
    // task adds startdate passthrough, also best-effort SmsV2Client.cancel(jobid)
    // here for each of the campaign's netgsmJobIds.
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

  /**
   * Freeze the audience, extract links, then either start sending now (flip to
   * SENDING + kick the first batch) or — with a future `scheduledAt` — flip to
   * SCHEDULED and queue a `campaign.launch` job to do that later.
   */
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
    // It needs a real held-back remainder to roll the winner out to — which
    // requires MORE leads than variants (test ≥1 per variant AND keep ≥1 back).
    // A smaller audience can't satisfy the documented "hold back at least 1"
    // invariant: testCount below would be forced up to the whole audience,
    // holding back NOBODY, yet a decide job would still be armed to release zero
    // recipients. Fall back to SPLIT (everyone gets a variant now, no decide
    // phase) in that case.
    const winnerMode =
      useAb && (campaign as any).abMode === 'WINNER' && leads.length > variants.length;
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

    const isScheduled = !!campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + SCHEDULE_TOLERANCE_MS;

    if (isScheduled) {
      // Freeze now (recipients/links/stats materialized above), exactly like the
      // immediate path — but don't start sending yet. Flip to SCHEDULED and let
      // the `campaign.launch` job do the SENDING flip + first batch kick at
      // scheduledAt. A/B WINNER's abDecideAt (the test-cohort window) is deferred
      // to that same moment too — it must be measured from when the test cohort
      // actually starts sending, not from this freeze time, or the decide job
      // could fire while the campaign is still SCHEDULED (no-op, and the held
      // remainder would never be released).
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: 'SCHEDULED',
          links: links as Prisma.InputJsonValue,
          stats: { recipients: leads.length, sent: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, unsubscribed: 0 },
        },
      });
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CAMPAIGN_LAUNCH_KIND,
        runAt: campaign.scheduledAt as Date,
        dedupKey: campaign.id,
        payload: { workspaceId, campaignId: campaign.id },
      });
      return {
        message: 'Campaign scheduled',
        recipients: leads.length,
        scheduledAt: campaign.scheduledAt,
        testCohort: winnerMode ? testLeads.length : undefined,
      };
    }

    // Immediate send (no future scheduledAt): start right now, exactly as before.
    // Clear any stray queued `campaign.launch` job — e.g. an admin re-launching a
    // still-SCHEDULED campaign ahead of its scheduled time forces it to send now
    // — so the old job doesn't linger as an orphaned PENDING row (harmless: the
    // handler's guarded updateMany would no-op it once status is SENDING).
    await this.scheduledJobs.cancel(CAMPAIGN_LAUNCH_KIND, campaign.id);
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
    // VOICE (NetGSM Phase 5): same phone reachability as SMS. Lead has no
    // dedicated call/voice opt-out flag yet — `smsOptOut` is reused as the
    // nearest proxy (both ring the same lead phone number); a dedicated
    // callOptOut/voiceOptOut column is a follow-up (see campaign-sender.
    // service.ts's isOptedOut for the same reuse on the send-time recheck).
    else if (channel === 'VOICE') { where.smsOptOut = false; where.phone = { not: null }; }

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
