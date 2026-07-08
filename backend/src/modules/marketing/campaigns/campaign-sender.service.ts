import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { MessageQuotaService } from '../channels/message-quota.service';
import { SendingDomainsService } from '../sending-domains/sending-domains.service';
import { ResolvedChannelConfig } from '../channels/channel-adapter.interface';
import { SmsV2Client, SmsV2SendResult } from '../../netgsm/sms/sms-v2.client';
import { CAMPAIGN_BATCH_KIND, CAMPAIGN_AB_DECIDE_KIND } from './campaigns.service';

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
    private readonly sendingDomains: SendingDomainsService,
    private readonly smsV2: SmsV2Client,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CAMPAIGN_BATCH_KIND, (job) => this.batch(job));
    this.runner.registerHandler(CAMPAIGN_AB_DECIDE_KIND, (job) => this.decideAbWinner(job));
  }

  /**
   * A/B WINNER mode: after the test window, pick the variant with the most
   * opens/clicks and release the held-back remainder to it. Atomic claim
   * (abWinnerKey:null) so only one decider releases the remainder.
   */
  private async decideAbWinner(job: ClaimedJob): Promise<void> {
    const { workspaceId, campaignId } = job.payload;
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign || (campaign as any).abWinnerKey || campaign.status !== 'SENDING') return;
    // Recompute variant stats from the recipient rows FIRST. `campaignVariant.stats`
    // is otherwise only written at the end of a batch() pass — and in WINNER mode
    // no batch runs during the test window (the remainder is HELD), so the cached
    // stats are frozen at ~0 from when the test cohort was just sent. Without this
    // recompute the winner sort collapses to the alphabetical key tiebreak and the
    // bulk audience gets the wrong variant. (Opens/clicks accrue on the recipient
    // rows via the tracker; this rolls them up into the per-variant counts.)
    await this.recomputeStats(workspaceId, campaignId);
    const variants = await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId } });
    if (variants.length < 2) return;
    const metric = (campaign as any).abWinnerMetric === 'CLICK' ? 'clicked' : 'opened';
    // Most opens/clicks wins; deterministic tiebreak by key so a no-data test is stable.
    const winner = [...variants].sort((a, b) => {
      const av = ((a.stats as any)?.[metric] ?? 0) as number;
      const bv = ((b.stats as any)?.[metric] ?? 0) as number;
      return bv - av || (a.key < b.key ? -1 : 1);
    })[0];
    const claimed = await this.prisma.campaign.updateMany({
      where: { id: campaignId, workspaceId, abWinnerKey: null, status: 'SENDING' },
      data: { abWinnerKey: winner.key },
    });
    if (claimed.count === 0) return; // a concurrent decide already released the remainder
    await this.prisma.campaignRecipient.updateMany({
      where: { workspaceId, campaignId, status: 'HOLD' },
      data: { status: 'PENDING', variantKey: winner.key },
    });
    this.logger.log(`campaign ${campaignId} A/B winner: variant ${winner.key} (by ${metric})`);
    await this.scheduledJobs.schedule({
      workspaceId, kind: CAMPAIGN_BATCH_KIND, runAt: new Date(), dedupKey: campaignId, payload: { workspaceId, campaignId },
    });
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
      // A/B WINNER mode: the test cohort is sent but the remainder is still HELD
      // awaiting the winner decision — the campaign is NOT done yet.
      const held = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'HOLD' } });
      if (held > 0) return; // leave SENDING; the ab.decide job releases the remainder
      await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', completedAt: new Date() } });
      return;
    }

    const links = (Array.isArray(campaign.links) ? campaign.links : []) as string[];

    // A/B: a recipient's variantKey selects that variant's subject/body/html.
    const variants = (campaign as any).abEnabled
      ? await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId } })
      : [];
    const variantByKey = new Map(variants.map((v: any) => [v.key, v]));

    // SMS true n:n batching: resolve the active SMS channel ONCE per tick (not
    // per recipient) so eligible recipients can be collected and sent via a
    // SINGLE SmsV2Client.send call instead of N adapter round-trips. A channel
    // that opted back into the legacy GET API (`useLegacySend`), one with
    // incomplete secrets, or a missing/inactive channel all fall through to the
    // existing per-recipient `this.send()` path unchanged (it re-resolves the
    // channel itself and fails/legacy-sends exactly as it does today).
    let smsV2Config: ResolvedChannelConfig | null = null;
    if (campaign.channel === 'SMS') {
      const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
      if (ch) {
        const resolved = this.registry.resolveConfig(ch);
        const { usercode, password, msgheader } = resolved.secrets;
        if (resolved.public?.useLegacySend !== true && usercode && password && msgheader) {
          smsV2Config = resolved;
        }
      }
    }
    const eligibleSms: Array<{ recipientId: string; phone: string; body: string }> = [];

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

      // Exclude a lead bulk-deleted (deletedAt) or merged-away (mergedIntoId)
      // AFTER the audience froze: bulk-delete means "stop contacting", and a
      // merged tombstone would double-send to the merge target's same address.
      // Such a lead resolves to null here → SKIPPED (mirrors opt-out).
      const lead = await this.prisma.lead.findFirst({
        where: { id: r.leadId, workspaceId, deletedAt: null, mergedIntoId: null },
      });
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
      if (smsV2Config) {
        // Defer the actual send: reserve this recipient's quota now (as today —
        // reserve→send stays paired so a later batch-level failure can refund
        // it), then collect for the single batched SmsV2Client.send call below.
        try {
          await this.quota.reserve(workspaceId, 'SMS');
        } catch (e: any) {
          await this.mark(r.id, 'FAILED', { error: (e?.message ?? String(e)).slice(0, 300) });
          continue;
        }
        eligibleSms.push({ recipientId: r.id, phone: to, body });
        continue;
      }

      const result = await this.send(workspaceId, campaign.channel, to, srcSubject, body, html);
      if (result.ok) {
        await this.mark(r.id, 'SENT', { messageId: result.messageId, sentAt: new Date() });
      } else {
        await this.mark(r.id, 'FAILED', { error: result.error?.slice(0, 300) });
      }
    }

    if (smsV2Config && eligibleSms.length > 0) {
      await this.sendSmsBatch(workspaceId, campaignId, campaign, smsV2Config, eligibleSms);
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
      // A/B WINNER: draining the test cohort to 0 PENDING does NOT complete the
      // campaign while the remainder is still HELD awaiting the winner decision.
      // Mirror the empty-batch guard at the top of batch() — without this, the
      // batch that sends the LAST test-cohort recipient marks the campaign SENT,
      // and the later ab.decide job (which requires status=SENDING) then bails,
      // stranding the held-back majority so they are NEVER sent.
      const held = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'HOLD' } });
      if (held > 0) return;
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
        // Per-workspace From from a VERIFIED sending domain — null (platform
        // default) unless an ESP transport is configured, so this is inert today.
        const from = (await this.sendingDomains.resolveFrom(workspaceId)) ?? undefined;
        const ok = html
          ? await this.email.sendCampaignEmail(to, subject ?? 'Update', body, html, from)
          : await this.email.sendPlainEmail(to, subject ?? 'Update', body, from);
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

  /**
   * ONE `SmsV2Client.send` call carrying every eligible recipient of this tick
   * (true n:n — each message keeps its own already-rendered body + referansId)
   * instead of the N adapter round-trips the per-recipient path would cost.
   * Quota for every recipient here was already reserved in the claim loop
   * above; on any batch-level failure it is refunded in bulk (nothing was
   * billed/sent for any of them — the call is all-or-nothing at the wire
   * level). `iysfilter` is the commercial/informational passthrough (brandcode
   * wiring is Phase 2); '11' for TICARI, '0' otherwise.
   */
  private async sendSmsBatch(
    workspaceId: string,
    campaignId: string,
    campaign: { iysMessageType?: string | null; netgsmJobIds?: unknown },
    config: ResolvedChannelConfig,
    eligible: Array<{ recipientId: string; phone: string; body: string }>,
  ): Promise<void> {
    const { usercode, password, msgheader } = config.secrets;
    const iysfilter = campaign.iysMessageType === 'TICARI' ? '11' : '0';
    let result: SmsV2SendResult;
    try {
      result = await this.smsV2.send(
        { usercode, password },
        {
          msgheader,
          messages: eligible.map((e) => ({ msg: e.body, no: e.phone, referansId: e.recipientId })),
          iysfilter,
        },
      );
    } catch (e: any) {
      // SmsV2Client.send is documented to never throw (every outcome resolves
      // to an ok:false result) — this is a defensive backstop only. Treat it
      // like any other non-retriable batch failure: nothing is known to have
      // been sent, so fail closed rather than silently drop the batch.
      result = { ok: false, code: '', jobid: null, message: e?.message ?? String(e), retriable: false, transport: false };
    }

    if (result.ok) {
      const jobid = result.jobid;
      const now = new Date();
      await Promise.all(
        eligible.map((e) =>
          this.mark(e.recipientId, 'SENT', { messageId: jobid, netgsmJobId: jobid, referansId: e.recipientId, sentAt: now }),
        ),
      );
      if (jobid) {
        const existing = Array.isArray(campaign.netgsmJobIds) ? (campaign.netgsmJobIds as string[]) : [];
        if (!existing.includes(jobid)) {
          await this.prisma.campaign.update({
            where: { id: campaignId },
            data: { netgsmJobIds: [...existing, jobid] as Prisma.InputJsonValue },
          });
        }
      }
      return;
    }

    // Batch-level failure: no recipient here was actually sent — refund every
    // reserved quota unit in one call.
    await this.quota.refund(workspaceId, 'SMS', eligible.length);
    const ids = eligible.map((e) => e.recipientId);
    if (result.retriable || result.transport) {
      // Code 80 (rate limit) or a genuine transport failure — nothing reached
      // NetGSM (or NetGSM asked us to back off), so revert the claim to
      // PENDING and let the next scheduled batch tick retry these recipients.
      await this.prisma.campaignRecipient.updateMany({
        where: { id: { in: ids }, workspaceId, campaignId },
        data: { status: 'PENDING' },
      });
      return;
    }
    const error = (result.message ?? `NetGSM ${result.code || '?'}`).slice(0, 300);
    await Promise.all(eligible.map((e) => this.mark(e.recipientId, 'FAILED', { error })));
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
    const [groups, openedCount, clickedCount] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { workspaceId, campaignId },
        _count: { _all: true },
      }),
      // Engagement is authoritatively recorded per-recipient (open/click set a
      // timestamp; unsubscribe sets status UNSUBSCRIBED — see CampaignTracking),
      // so it is fully derivable from the rows.
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, openedAt: { not: null } } }),
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, clickedAt: { not: null } } }),
    ]);
    const countOf = (status: string) =>
      groups.find((g) => g.status === status)?._count._all ?? 0;
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { stats: true, abEnabled: true } });
    const s = (c?.stats ?? {}) as Record<string, number>;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        stats: {
          // `recipients` is a static launch-time total (never bumped) — preserve it.
          ...(s.recipients !== undefined ? { recipients: s.recipients } : {}),
          sent: countOf('SENT'),
          failed: countOf('FAILED'),
          skipped: countOf('SKIPPED'),
          // Recompute engagement from the recipient rows (the source of truth)
          // rather than carrying it forward from the stored blob. opened/clicked/
          // unsubscribed are maintained by the tracker's atomic jsonb_set bump();
          // re-writing them here from a STALE `...s` snapshot clobbered a concurrent
          // open/click/unsubscribe (the live lost-update this method claimed to be
          // immune to). Deriving all fields from rows makes the recompute truly
          // convergent under concurrency.
          opened: openedCount,
          clicked: clickedCount,
          unsubscribed: countOf('UNSUBSCRIBED'),
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
