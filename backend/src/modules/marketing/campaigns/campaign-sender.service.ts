import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { MessageQuotaService } from '../channels/message-quota.service';
import { CAMPAIGN_BATCH_KIND } from './campaigns.service';

const BATCH_SIZE = 50;
const BATCH_INTERVAL_SEC = 60; // ~50 sends/min throttle

/** Pair each link with its original index, ordered longest-first — so a tracked
 *  rewrite replaces a longer URL before a shorter URL that is its prefix, while
 *  the original index still drives the ?i= redirect lookup. */
function byLengthDesc(links: string[]): Array<{ url: string; i: number }> {
  return links.map((url, i) => ({ url, i })).sort((a, b) => b.url.length - a.url.length);
}

/** HTML-escape (used to match escaped hrefs in the compiled email HTML). */
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Sends a SENDING campaign in throttled batches via the `campaign.batch`
 * ScheduledJob (dedupKey = campaignId → one batch in flight per campaign;
 * single-replica runner = no double-send). Opt-out is re-checked at send time
 * (the audience froze earlier); every message gets a mandatory unsubscribe
 * footer + click-tracked links. Email goes via EmailService; SMS/WhatsApp via
 * the channel adapter (metered), with no per-recipient conversation (replies
 * still land in the inbox through the normal inbound webhook → ingress).
 */
@Injectable()
export class CampaignSenderService implements OnModuleInit {
  private readonly logger = new Logger(CampaignSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly quota: MessageQuotaService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CAMPAIGN_BATCH_KIND, (job) => this.batch(job));
  }

  private async batch(job: ClaimedJob): Promise<void> {
    const { workspaceId, campaignId } = job.payload;
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign || campaign.status !== 'SENDING') return;

    // Reclaim recipients stranded in SENDING by a prior batch that crashed
    // between the PENDING→SENDING claim and the SENT/FAILED mark. The batch
    // below selects only PENDING, so without this they'd be silently dropped
    // (and the campaign reported SENT). Safe: the job dedups on campaignId, so
    // only one batch per campaign runs at a time — any SENDING here is stale.
    await this.prisma.campaignRecipient.updateMany({
      where: { workspaceId, campaignId, status: 'SENDING' },
      data: { status: 'PENDING' },
    });

    const recipients = await this.prisma.campaignRecipient.findMany({
      where: { workspaceId, campaignId, status: 'PENDING' },
      take: BATCH_SIZE,
    });
    if (recipients.length === 0) {
      await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', completedAt: new Date() } });
      return;
    }

    const links = (Array.isArray(campaign.links) ? campaign.links : []) as string[];

    // A/B: a recipient's variantKey selects that variant's subject/body/html.
    const variants = (campaign as any).abEnabled
      ? await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId } })
      : [];
    const variantByKey = new Map(variants.map((v: any) => [v.key, v]));

    for (const r of recipients) {
      // Atomic claim: a concurrent batch — e.g. a slow run reaped after 15 min and
      // re-dispatched while still in flight — that re-read the same PENDING rows
      // cannot also process this recipient. Only one updateMany flips PENDING→
      // SENDING; the loser sees count 0 and skips, so no double-send / double-meter.
      const claim = await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, workspaceId, status: 'PENDING' },
        data: { status: 'SENDING' },
      });
      if (claim.count === 0) continue;

      const lead = await this.prisma.lead.findFirst({ where: { id: r.leadId, workspaceId } });
      const to = this.recipientAddress(campaign.channel, lead);
      if (!lead || this.isOptedOut(campaign.channel, lead) || !to) {
        await this.mark(r.id, 'SKIPPED');
        continue;
      }
      // Resolve this recipient's content: their assigned A/B variant if any,
      // else the campaign control.
      const variant = (r as any).variantKey ? variantByKey.get((r as any).variantKey) : null;
      const srcBody = variant ? (variant as any).body : campaign.body;
      const srcSubject = variant ? ((variant as any).subject ?? campaign.subject) : campaign.subject;
      // A variant without its own HTML inherits the campaign's — so an HTML
      // campaign's A/B test varies the subject (+ plain-text part) rather than
      // silently degrading variant recipients to plain text.
      const srcHtml = variant ? ((variant as any).bodyHtml ?? (campaign as any).bodyHtml) : (campaign as any).bodyHtml;

      const body = this.render(campaign.channel, srcBody, r.token, links);
      // EMAIL campaigns built with the block editor carry an HTML body; render it
      // (tracked links + HTML unsubscribe footer) and send it as the html part.
      const html =
        campaign.channel === 'EMAIL' && srcHtml
          ? this.renderHtml(srcHtml as string, r.token, links)
          : undefined;
      const result = await this.send(workspaceId, campaign.channel, to, srcSubject, body, html);
      if (result.ok) {
        await this.mark(r.id, 'SENT', { messageId: result.messageId, sentAt: new Date() });
      } else {
        await this.mark(r.id, 'FAILED', { error: result.error?.slice(0, 300) });
      }
    }

    await this.recomputeStats(workspaceId, campaignId);

    const remaining = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'PENDING' } });
    if (remaining > 0) {
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CAMPAIGN_BATCH_KIND,
        runAt: new Date(Date.now() + BATCH_INTERVAL_SEC * 1000),
        dedupKey: campaignId,
        payload: { workspaceId, campaignId },
      });
    } else {
      await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', completedAt: new Date() } });
    }
  }

  private isOptedOut(channel: string, lead: any): boolean {
    if (channel === 'EMAIL') return !!lead.emailOptOut;
    if (channel === 'SMS') return !!lead.smsOptOut;
    if (channel === 'WHATSAPP') return !!lead.waOptOut;
    return false;
  }

  private recipientAddress(channel: string, lead: any): string | null {
    if (!lead) return null;
    if (channel === 'EMAIL') return lead.email ?? null;
    if (channel === 'SMS') return lead.phone ?? null;
    if (channel === 'WHATSAPP') return lead.whatsapp || lead.phone || null;
    return null;
  }

  private async send(
    workspaceId: string, channel: string, to: string, subject: string | null, body: string, html?: string,
  ): Promise<{ ok: boolean; messageId?: string | null; error?: string }> {
    try {
      // The unsubscribe link is mandatory and is built from PUBLIC_BASE_URL; if
      // it's unset the rendered body has no opt-out, so refuse to send rather
      // than ship non-compliant mail (a misconfigured deploy fails closed).
      if (!(this.config.get<string>('PUBLIC_BASE_URL') ?? '')) {
        return { ok: false, error: 'PUBLIC_BASE_URL not configured (unsubscribe link required)' };
      }
      if (channel === 'EMAIL') {
        const ok = html
          ? await this.email.sendCampaignEmail(to, subject ?? 'Update', body, html)
          : await this.email.sendPlainEmail(to, subject ?? 'Update', body);
        return { ok, messageId: null, error: ok ? undefined : 'email send failed' };
      }
      const channelType = channel === 'SMS' ? 'SMS' : 'WHATSAPP';
      const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: channelType, status: 'ACTIVE' } });
      if (!ch) return { ok: false, error: `no active ${channelType} channel` };
      // Reserve→send must be paired: if the adapter THROWS (network/provider
      // error), the reserved quota would otherwise leak. Refund on throw too,
      // mirroring the explicit result.status==='FAILED' refund below.
      await this.quota.reserve(workspaceId, channelType);
      try {
        const result = await this.registry.get(channelType).send({ config: this.registry.resolveConfig(ch), to, text: body });
        if (result.status === 'FAILED') {
          await this.quota.refund(workspaceId, channelType);
          return { ok: false, error: result.error };
        }
        return { ok: true, messageId: result.externalMessageId };
      } catch (e: any) {
        await this.quota.refund(workspaceId, channelType);
        return { ok: false, error: e?.message ?? String(e) };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /** Rewrite links to click-tracked URLs + append a mandatory unsubscribe footer. */
  private render(channel: string, body: string, token: string, links: string[]): string {
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    let out = body;
    if (base) {
      // Rewrite longest URLs first (keeping the original index for ?i=) so a URL
      // that is a string-prefix of another isn't matched inside the longer one.
      for (const { url, i } of byLengthDesc(links)) {
        out = out.split(url).join(`${base}/api/public/t/c/${token}?i=${i}`);
      }
      const unsub = `${base}/api/public/u/${token}`;
      out += channel === 'SMS' ? `\nStop: ${unsub}` : `\n\n—\nUnsubscribe: ${unsub}`;
    }
    return out;
  }

  /**
   * HTML body variant: rewrite the campaign-authored links to click-tracked URLs
   * (matching BOTH the raw and HTML-escaped form, since the compiled HTML escapes
   * hrefs) and append a mandatory HTML unsubscribe footer. `links` holds the real
   * (decoded) URLs so the tracked redirect target stays correct.
   */
  private renderHtml(html: string, token: string, links: string[]): string {
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    let out = html;
    if (base) {
      for (const { url, i } of byLengthDesc(links)) {
        const tracked = `${base}/api/public/t/c/${token}?i=${i}`;
        out = out.split(esc(url)).join(tracked).split(url).join(tracked);
      }
      const unsub = `${base}/api/public/u/${token}`;
      const footer =
        `<table role="presentation" width="100%"><tr><td align="center" style="padding:16px;font-size:12px;color:#94a3b8">` +
        `<a href="${esc(unsub)}" style="color:#94a3b8">Unsubscribe</a></td></tr></table>`;
      // The compiled email HTML always has </body>; fall back to appending for a
      // hand-authored fragment so the mandatory unsubscribe link is never lost.
      out = out.includes('</body>') ? out.replace('</body>', `${footer}</body>`) : out + footer;
    }
    return out;
  }

  private async mark(id: string, status: string, extra: Record<string, any> = {}): Promise<void> {
    await this.prisma.campaignRecipient.update({ where: { id }, data: { status, ...extra } });
  }

  /**
   * Recompute send stats from the recipient rows (the source of truth) rather
   * than accumulating per-batch deltas. This is idempotent (a reaped/re-run batch
   * can't double-count) and immune to the lost-update race of a read-modify-write
   * on the JSON `stats` blob: even interleaved writers converge on the true count.
   */
  private async recomputeStats(workspaceId: string, campaignId: string): Promise<void> {
    const groups = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { workspaceId, campaignId },
      _count: { _all: true },
    });
    const countOf = (status: string) =>
      groups.find((g) => g.status === status)?._count._all ?? 0;
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { stats: true, abEnabled: true } });
    const s = (c?.stats ?? {}) as Record<string, number>;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        stats: {
          ...s,
          sent: countOf('SENT'),
          failed: countOf('FAILED'),
          skipped: countOf('SKIPPED'),
        } as Prisma.InputJsonValue,
      },
    });

    // Per-variant A/B stats — only for an A/B-enabled campaign, so a non-A/B
    // campaign (which may still have a lone leftover variant row) never pays for
    // the extra groupBys on the throttled batch path.
    const variants = (c as any)?.abEnabled
      ? await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId }, select: { id: true, key: true } })
      : [];
    if (variants.length) {
      const [sentG, openG, clickG] = await Promise.all([
        this.prisma.campaignRecipient.groupBy({ by: ['variantKey'], where: { workspaceId, campaignId, status: 'SENT' }, _count: { _all: true } }),
        this.prisma.campaignRecipient.groupBy({ by: ['variantKey'], where: { workspaceId, campaignId, openedAt: { not: null } }, _count: { _all: true } }),
        this.prisma.campaignRecipient.groupBy({ by: ['variantKey'], where: { workspaceId, campaignId, clickedAt: { not: null } }, _count: { _all: true } }),
      ]);
      const cnt = (g: any[], key: string) => g.find((x) => x.variantKey === key)?._count._all ?? 0;
      await Promise.all(
        variants.map((v) =>
          this.prisma.campaignVariant.update({
            where: { id: v.id },
            data: { stats: { sent: cnt(sentG, v.key), opened: cnt(openG, v.key), clicked: cnt(clickG, v.key) } as Prisma.InputJsonValue },
          }),
        ),
      );
    }
  }
}
