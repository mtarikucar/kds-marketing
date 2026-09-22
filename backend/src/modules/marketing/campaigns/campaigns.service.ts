import {
  Inject,
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
import { SegmentCompilerService, SegmentNode } from '../services/segment-compiler.service';
import { extractCampaignLinks } from './campaign-links.util';
import { IYS_EMAIL_PORT, IysEmailPort } from '../compliance/iys-email.port';

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
  // `id` makes a ONE-RECIPIENT campaign expressible, which is what turns
  // "email this one lead" into a compliant operation instead of a raw SMTP
  // call: it still goes through launch() + CampaignSenderService, so it still
  // gets the send-time opt-out recheck, the deliverability filter, the
  // mandatory unsubscribe footer and the tracking/stats every other campaign
  // gets. Used by the MCP `jeeta.send_email` tool (mcp/tools/email.tools.ts);
  // `EmailService.sendPlainEmail` was deliberately NOT wrapped because it
  // enforces none of that. Safe to allow: the filter loop only ever ANDs onto
  // a `where` that already pins workspaceId plus the opt-out/reachability
  // guards, and `id` can only ever NARROW that set.
  'id',
]);

/** Fields whose stored values are an UPPER_SNAKE taxonomy (schema.prisma's Lead
 *  comments; `businessType` is validated by BUSINESS_TYPE_PATTERN). Typing
 *  "new" in the audience builder must match `NEW` — so the VALUE is normalized
 *  here rather than the comparison loosened. Prisma's `mode:'insensitive'` is
 *  ILIKE on Postgres: `%`/`_` in the value would become wildcards, and on the
 *  whitelisted `id` field that turns the MCP "email this one lead" filter into
 *  a blast. Never make `eq` insensitive. */
const ENUMISH_FILTER_FIELDS = new Set(['status', 'priority', 'source', 'businessType']);

/** Audience filter fields that are NOT lead columns and are handled on their
 *  own branch: `tag` compiles to a relation predicate, `segmentId` needs a DB
 *  read and is resolved by `resolveAudienceWhere`. */
const TAG_FILTER_FIELD = 'tag';
const SEGMENT_FILTER_FIELD = 'segmentId';

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
    private readonly segmentCompiler: SegmentCompilerService,
    @Inject(IYS_EMAIL_PORT) private readonly iysEmail: IysEmailPort,
  ) {}

  /**
   * What `iysMessageType` this campaign may actually be stored as.
   *
   * SMS and VOICE have always been allowed to be TİCARİ: their senders run an
   * İYS preflight before every recipient. EMAIL was coerced to BİLGİLENDİRME
   * unconditionally because nothing checked İYS for email — which is no longer
   * true, but only in a workspace that armed the gate. So the unlock is
   * conditional on exactly the readiness the gate reads: arming it any wider
   * would mark mail commercial that no İYS check will ever cover, which is the
   * 6563 exposure the coercion existed to avoid (`tr-commercial-compliance`).
   *
   * WHATSAPP stays coerced: İYS has no lane for it.
   */
  private async resolveIysMessageType(
    workspaceId: string,
    channel: string,
    requested: string | undefined,
  ): Promise<'TICARI' | 'BILGILENDIRME'> {
    if (requested !== 'TICARI') return 'BILGILENDIRME';
    if (channel === 'SMS' || channel === 'VOICE') return 'TICARI';
    // Only EMAIL gets as far as the port, and only when TİCARİ was asked for —
    // an ordinary campaign save must not cost a config read.
    if (channel !== 'EMAIL') return 'BILGILENDIRME';
    const readiness = await this.iysEmail.readiness(workspaceId);
    return readiness.configured ? 'TICARI' : 'BILGILENDIRME';
  }

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

  /**
   * Read-only performance snapshot for one campaign — deliberately narrower
   * than `get()` (no variants, no body/audienceFilter draft fields). The
   * counters live in `Campaign.stats`, kept fresh by three independent
   * writers: `campaign-sender.service.ts` (sent/failed/skipped/delivered),
   * `campaign-tracking.service.ts` (opened/clicked/unsubscribed) and
   * `campaign-sms-stats.service.ts` (NetGSM per-status SMS rollup under
   * `stats.sms`). Neither of those two files exposes a per-campaign read —
   * they only ever write into this same JSON blob — so this scoped select
   * is the one true "how did this campaign perform" source.
   */
  async performance(workspaceId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        name: true,
        channel: true,
        status: true,
        stats: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
      },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
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
    // A variant carrying only a template id used to inherit the CONTROL's HTML
    // at send time — the wrong template's content, not merely plain text. Same
    // strict resolve as create()/update(), one query for all variants.
    const variantTemplates = await this.loadTemplateHtml(
      workspaceId,
      dto.variants.map((v) => v.emailTemplateId),
    );
    for (const v of dto.variants) {
      if (v.emailTemplateId && !variantTemplates.has(v.emailTemplateId)) {
        throw new BadRequestException('Email template not found');
      }
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
              bodyHtml:
                (v.emailTemplateId ? variantTemplates.get(v.emailTemplateId) : null) ||
                v.bodyHtml ||
                null,
              emailTemplateId: v.emailTemplateId || null,
            })),
          })]
        : []),
      this.prisma.campaign.updateMany({
        where: { id: campaignId, workspaceId },
        data: { abEnabled, abMode, abTestPercent, abWinnerMetric, abWinnerKey: null, abDecideAt: null },
      }),
    ]);
    // A SCHEDULED campaign's recipients were frozen WITH their variantKey at
    // launch(). Replacing the variant set here would leave a recipient pointing
    // at a removed/renamed key — the sender silently degrades it to the control
    // body. Revert to DRAFT (cancel launch + drop the all-unsent frozen
    // recipients) so a re-launch re-freezes against the new variant set.
    if (c.status === 'SCHEDULED') {
      await this.scheduledJobs.cancel(CAMPAIGN_LAUNCH_KIND, campaignId);
      await this.prisma.campaignRecipient.deleteMany({ where: { campaignId, workspaceId } });
      await this.prisma.campaign.updateMany({ where: { id: campaignId, workspaceId }, data: { status: 'DRAFT' } });
    }
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
    // Resolve the template NOW rather than storing an unchecked 64-char string:
    // a caller that passes only a template id (the MCP tools do) gets its HTML
    // rendered into the campaign instead of a plain-text send. When both are
    // given the TEMPLATE wins — attaching a template means "this campaign is
    // this template", and `launch()` re-renders it the same way, so anything
    // else would make create and launch disagree. (The campaign form always
    // sends the template's own compiled HTML as bodyHtml, so nothing changes
    // for it.)
    const templateHtml = dto.emailTemplateId
      ? await this.requireTemplateHtml(workspaceId, dto.emailTemplateId)
      : null;
    return this.prisma.campaign.create({
      data: {
        workspaceId,
        name: dto.name,
        channel: dto.channel,
        subject: dto.subject || null,
        body: dto.body,
        bodyHtml: templateHtml || dto.bodyHtml || null,
        emailTemplateId: dto.emailTemplateId || null,
        audienceFilter: (dto.audienceFilter ?? []) as Prisma.InputJsonValue,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        // Never taken from the DTO as given: a stray TİCARİ on a channel with
        // no İYS lane behind it would ride along into CampaignsPage.tsx's
        // display and into the sender's `ticari` flag. See resolveIysMessageType.
        iysMessageType: await this.resolveIysMessageType(workspaceId, dto.channel, dto.iysMessageType),
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
    // Same normalisation as create(): channel itself isn't editable (not in the
    // field loop above), so `existing.channel` is this campaign's permanent
    // channel and the same per-channel rule applies to an edit.
    if (dto.iysMessageType !== undefined) {
      data.iysMessageType = await this.resolveIysMessageType(workspaceId, existing.channel, dto.iysMessageType);
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
    // Same server-side template resolution as create(): a NEWLY chosen template
    // must actually change what ships, and an id from another workspace is a
    // caller error rather than a silently plain send. Only on a CHANGE, though:
    // the campaign form resends the stored id on every save, so validating an
    // unchanged one would make a campaign whose template was later deleted
    // impossible to even rename. An unchanged id is re-rendered at launch().
    if (
      typeof data.emailTemplateId === 'string' &&
      data.emailTemplateId &&
      data.emailTemplateId !== (existing as any).emailTemplateId
    ) {
      const html = await this.requireTemplateHtml(workspaceId, data.emailTemplateId);
      if (html) data.bodyHtml = html;
    }

    // A SCHEDULED campaign's links[] were frozen at launch(), and `?i=` indexes
    // into that array — so an edited body would send new CTAs untracked (and,
    // worse, could point an old index at a URL that is no longer in the body).
    // Nothing has been sent yet in SCHEDULED (the launch job hasn't run), so
    // recomputing here is safe; the same is NOT true once a campaign is
    // SENDING, which update() already refuses.
    const contentEdited = ['body', 'bodyHtml', 'emailTemplateId'].some(
      (k) => data[k] !== undefined && data[k] !== (existing as any)[k],
    );
    if (existing.status === 'SCHEDULED' && contentEdited) {
      const variants = (existing as any).abEnabled
        ? await this.prisma.campaignVariant.findMany({
            where: { workspaceId, campaignId: existing.id },
            orderBy: { key: 'asc' },
          })
        : [];
      data.links = extractCampaignLinks(
        {
          body: data.body !== undefined ? data.body : existing.body,
          bodyHtml: data.bodyHtml !== undefined ? data.bodyHtml : (existing as any).bodyHtml,
        },
        variants.map((v: any) => ({ body: v.body, bodyHtml: v.bodyHtml })),
      ) as any;
    }
    const updated = await this.prisma.campaign.update({ where: { id: existing.id }, data });

    // A SCHEDULED campaign froze its audience into CampaignRecipient rows at
    // launch(). If the audience filter actually CHANGES, those frozen rows are
    // stale — the scheduled send would go to the ORIGINAL audience (including
    // leads the operator just excluded), wasting credits and hitting people
    // they dropped, while the UI shows the new (narrower) filter as saved.
    // Revert to DRAFT: cancel the queued launch, drop the (all-unsent — it
    // hasn't started SENDING) frozen recipients, so a re-launch re-freezes from
    // the new filter. Same revert pattern the scheduledAt-cleared branch uses.
    const audienceChanged =
      dto.audienceFilter !== undefined &&
      JSON.stringify(existing.audienceFilter ?? null) !== JSON.stringify(dto.audienceFilter ?? null);
    if (existing.status === 'SCHEDULED' && audienceChanged) {
      await this.scheduledJobs.cancel(CAMPAIGN_LAUNCH_KIND, existing.id);
      await this.prisma.campaignRecipient.deleteMany({ where: { campaignId: existing.id, workspaceId } });
      await this.prisma.campaign.update({ where: { id: existing.id }, data: { status: 'DRAFT' } });
      updated.status = 'DRAFT';
      return updated; // reverted — skip the scheduledAt re-schedule (job is cancelled)
    }

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
        // stranding the campaign SCHEDULED with no queued job. Drop the frozen
        // recipients too, exactly like the audience-change and variant-edit
        // reverts above: a re-freeze is idempotent (@@unique([campaignId,
        // leadId]) + skipDuplicates), which is precisely why leaving them would
        // make a later launch() mail the UNION of the old audience and the new
        // one — the operator narrows the filter from 800 leads to 60 and 860
        // are mailed. Safe: SCHEDULED means the launch job has not run, so no
        // row can be SENT.
        await this.scheduledJobs.cancel(CAMPAIGN_LAUNCH_KIND, existing.id);
        await this.prisma.campaignRecipient.deleteMany({ where: { campaignId: existing.id, workspaceId } });
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
    const where = await this.resolveAudienceWhere(workspaceId, campaign.channel, campaign.audienceFilter);
    const leads = await this.prisma.lead.findMany({ where: { ...where, workspaceId }, select: { id: true } });
    if (leads.length === 0) throw new BadRequestException('Audience is empty (no opted-in, reachable leads match)');

    // A/B: split recipients across variants by weight (frozen here at launch).
    // `orderBy key` is not cosmetic: links[] is an index and two computations
    // over the same content must yield the same order.
    const variants = (campaign as any).abEnabled
      ? await this.prisma.campaignVariant.findMany({
          where: { workspaceId, campaignId: campaign.id },
          orderBy: { key: 'asc' },
        })
      : [];
    const useAb = variants.length > 1;

    // Re-render every attached template at freeze time, so a typo fixed in the
    // template after the draft was built does ship. Lenient on purpose: a
    // template that no longer resolves falls back to the stored HTML rather
    // than stranding a draft that can never launch again. This is a
    // freeze-time snapshot — `launchScheduled()` does not re-enter launch(),
    // so it can never mutate an in-flight send.
    const templates = await this.loadTemplateHtml(workspaceId, [
      (campaign as any).emailTemplateId,
      ...variants.map((v: any) => v.emailTemplateId),
    ]);
    const freshHtml = (id: string | null | undefined, current: string | null | undefined) =>
      (id ? templates.get(id) : null) || current || null;
    const campaignHtml = freshHtml((campaign as any).emailTemplateId, (campaign as any).bodyHtml);
    for (const v of variants as any[]) {
      const html = freshHtml(v.emailTemplateId, v.bodyHtml);
      if (html !== (v.bodyHtml ?? null)) {
        // Persist it: the sender re-reads the variant rows per batch, so an
        // in-memory refresh alone would fix the tracked links and still send
        // the stale body.
        await this.prisma.campaignVariant.updateMany({
          where: { id: v.id, workspaceId, campaignId: campaign.id },
          data: { bodyHtml: html },
        });
        v.bodyHtml = html;
      }
    }

    // Track links from the control body+HTML AND every variant body+HTML. The
    // HTML half reads `<a href>` only: an `<img src>` rewritten to the click
    // tracker turns every image load — Gmail's cache, Apple MPP — into a
    // recorded click (img-src-click).
    const links = extractCampaignLinks(
      { body: campaign.body, bodyHtml: campaignHtml },
      (variants as any[]).map((v) => ({ body: v.body, bodyHtml: v.bodyHtml })),
    );

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

    // Belt-and-braces re-freeze hygiene: a DRAFT campaign may still carry rows
    // frozen by an earlier launch that was reverted (or that crashed halfway).
    // The re-freeze below is idempotent (@@unique + skipDuplicates), so those
    // stale rows would SURVIVE it and be mailed alongside the current audience.
    // Scope is load-bearing — SENT/FAILED/SKIPPED/UNSUBSCRIBED rows are the
    // audit trail AND the token behind every open pixel and unsubscribe link
    // already sitting in an inbox, so they are never touched. A still-SCHEDULED
    // campaign being re-launched early keeps its frozen rows as today.
    if (campaign.status === 'DRAFT') {
      await this.prisma.campaignRecipient.deleteMany({
        where: { workspaceId, campaignId: campaign.id, status: { in: ['PENDING', 'HOLD'] } },
      });
    }
    // Materialize recipients (skip dupes if a previous partial launch raced).
    // `channel` is frozen onto EVERY row — the test cohort AND the held-back
    // remainder: a bounce or complaint writer finds its rows by that column, so
    // a null channel on the held rows would make the A/B majority invisible to
    // deliverability feedback.
    const tok = () => `cr_${randomBytes(18).toString('hex')}`;
    await this.prisma.campaignRecipient.createMany({
      data: [
        ...testLeads.map((l) => ({
          workspaceId, campaignId: campaign.id, leadId: l.id, token: tok(),
          channel: campaign.channel,
          variantKey: useAb ? this.pickVariant(variants) : null,
        })),
        ...holdLeads.map((l) => ({
          workspaceId, campaignId: campaign.id, leadId: l.id, token: tok(),
          channel: campaign.channel,
          variantKey: null, status: 'HOLD', // released to PENDING when the winner is picked
        })),
      ],
      skipDuplicates: true,
    });

    // Only write the refreshed template HTML when it actually changed, so a
    // campaign without a template (or whose template was deleted) keeps
    // exactly the body it had.
    const htmlRefresh =
      campaignHtml !== (((campaign as any).bodyHtml ?? null) as string | null)
        ? { bodyHtml: campaignHtml }
        : {};

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
          ...htmlRefresh,
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
        ...htmlRefresh,
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

    // Relation predicates (tag membership) go into an AND ARRAY, never onto a
    // key: `where.tags = …` twice would silently collide and only the last rule
    // would survive ("in fuar-2026 AND not in musteri" would become one of the
    // two). The base `where` keeps its own keys — in particular WHATSAPP's
    // reachability `OR` — untouched.
    const ands: Prisma.LeadWhereInput[] = [];

    const filters = Array.isArray(audienceFilter) ? (audienceFilter as AudienceFilter[]) : [];
    for (const f of filters) {
      const field = f.field?.replace(/^lead\./, '');
      if (!field) continue;
      if (field === TAG_FILTER_FIELD) {
        const tagId = typeof f.value === 'string' ? f.value : null;
        if (!tagId) continue;
        // `neq` is "not tagged", i.e. `none` — NOT `some: { tagId: { not } }`,
        // which would match any lead carrying at least one OTHER tag.
        ands.push(f.op === 'neq' ? { tags: { none: { tagId } } } : { tags: { some: { tagId } } });
        continue;
      }
      // A saved segment is compiled against the DB (custom fields, tags) and is
      // therefore resolved by `resolveAudienceWhere`; it is never a lead column.
      if (field === SEGMENT_FILTER_FIELD) continue;
      if (!LEAD_FILTER_FIELDS.has(field)) continue;
      const enumish = ENUMISH_FILTER_FIELDS.has(field);
      const norm = (v: any) => (enumish && typeof v === 'string' ? v.toUpperCase() : v);
      const value = Array.isArray(f.value) ? f.value.map(norm) : norm(f.value);
      // A scalar op needs a scalar value: an ARRAY would compile to e.g.
      // `{ status: ['a','b'] }`, an invalid Prisma filter that 500s when the
      // audience is materialized. Guard the scalar ops the same way `in` already
      // guards against a non-array — drop the malformed leaf rather than poison
      // the whole where.
      const scalar = !Array.isArray(value);
      switch (f.op) {
        case 'eq': if (scalar) where[field] = value; break;
        case 'neq': if (scalar) where[field] = { not: value }; break;
        case 'in': if (Array.isArray(value)) where[field] = { in: value }; break;
        case 'contains': where[field] = { contains: String(f.value), mode: 'insensitive' }; break;
        case 'gte': if (scalar) where[field] = { gte: value }; break;
        case 'lte': if (scalar) where[field] = { lte: value }; break;
        case 'exists': where[field] = f.value ? { not: null } : null; break;
      }
    }
    if (ands.length) where.AND = ands;
    return where as Prisma.LeadWhereInput;
  }

  /**
   * The audience `where` the send ACTUALLY uses: `buildAudienceWhere` plus the
   * saved segments it can't resolve synchronously. Both `launch()` and the
   * audience-preview endpoint go through this one method so a preview and a
   * send can never disagree.
   */
  async resolveAudienceWhere(
    workspaceId: string,
    channel: string,
    audienceFilter: unknown,
  ): Promise<Prisma.LeadWhereInput> {
    const where = this.buildAudienceWhere(workspaceId, channel, audienceFilter) as any;
    const filters = Array.isArray(audienceFilter) ? (audienceFilter as AudienceFilter[]) : [];
    const segmentIds = filters
      .filter((f) => f.field?.replace(/^lead\./, '') === SEGMENT_FILTER_FIELD && typeof f.value === 'string')
      .map((f) => f.value as string);
    if (segmentIds.length === 0) return where as Prisma.LeadWhereInput;

    const ands: Prisma.LeadWhereInput[] = Array.isArray(where.AND) ? where.AND : [];
    for (const id of [...new Set(segmentIds)]) {
      // Tenant-scoped exactly like SegmentsService.getOwned. A segment that does
      // not resolve must REFUSE, never be skipped: silently dropping the leaf
      // would widen the audience to everyone the other rules still allow.
      const segment = await this.prisma.segment.findFirst({
        where: { id, workspaceId },
        select: { definition: true },
      });
      if (!segment) throw new BadRequestException('Segment not found');
      // AND only. `compile()` returns `{ AND: [...] }` and the WHATSAPP branch
      // already owns `where.OR`, so a key-level merge would clobber the
      // reachability guard and widen the audience.
      ands.push(this.segmentCompiler.compile(workspaceId, segment.definition as unknown as SegmentNode));
    }
    where.AND = ands;
    return where as Prisma.LeadWhereInput;
  }

  /**
   * Resolve `emailTemplateId`s to their compiled HTML, workspace-scoped.
   *
   * Until this existed the id was stored but never read: an MCP/template send
   * went out with no HTML at all, and a typo fixed in the template still
   * shipped the old copy. One `findMany` covers the control and every variant.
   */
  private async loadTemplateHtml(
    workspaceId: string,
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, string | null>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (wanted.length === 0) return new Map();
    const rows = await this.prisma.emailTemplate.findMany({
      where: { id: { in: wanted }, workspaceId },
      select: { id: true, compiledHtml: true },
    });
    return new Map(rows.map((r) => [r.id, r.compiledHtml]));
  }

  /** Strict resolve for an EDIT: an id that doesn't belong to this workspace is
   *  a caller error (an MCP agent gets a real error instead of a silently plain
   *  send). Launch uses the lenient path instead — see `launch()`. */
  private async requireTemplateHtml(workspaceId: string, id: string): Promise<string | null> {
    const found = await this.loadTemplateHtml(workspaceId, [id]);
    if (!found.has(id)) throw new BadRequestException('Email template not found');
    return found.get(id) ?? null;
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

}
