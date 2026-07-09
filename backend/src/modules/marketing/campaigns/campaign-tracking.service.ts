import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes, MarketingSmsOptStatusPayload } from '../events/marketing-event-types';

/**
 * Resolves the unguessable per-recipient token behind open/click/unsubscribe
 * links and records the event. Click only ever returns a URL that was in the
 * campaign body at launch (Campaign.links), so the tracker can't be turned into
 * an open redirect. Unsubscribe flips the lead's per-channel opt-out so future
 * campaigns AND the AI engine honor it.
 */
@Injectable()
export class CampaignTrackingService {
  private readonly logger = new Logger(CampaignTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async open(token: string): Promise<void> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { token } });
    if (!r || r.openedAt) return;
    // A mail-client prefetch + the real open (or a proxied retry) hit the pixel
    // near-simultaneously — a VERY common case. The old check-then-act let BOTH
    // pass the openedAt-null check and each `bump`, double-counting the campaign's
    // "unique opens". Gate the bump on WINNING the openedAt:null→set transition:
    // only the first concurrent hit's updateMany matches a row (count 1), so the
    // open is counted exactly once. (The bump itself was already atomic.)
    const claim = await this.prisma.campaignRecipient.updateMany({
      where: { id: r.id, openedAt: null },
      data: { openedAt: new Date() },
    });
    if (claim.count === 1) await this.bump(r.campaignId, 'opened');
  }

  /** Returns the campaign-authored destination URL, or null (no open redirect). */
  async click(token: string, index: number): Promise<string | null> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { token } });
    if (!r) return null;
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: r.campaignId, workspaceId: r.workspaceId },
      select: { links: true },
    });
    const links = (Array.isArray(campaign?.links) ? campaign!.links : []) as string[];
    const url = links[index];
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (!r.clickedAt) {
      // Same race-safe claim as open(): only the first concurrent click counts.
      const claim = await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, clickedAt: null },
        data: { clickedAt: new Date() },
      });
      if (claim.count === 1) await this.bump(r.campaignId, 'clicked');
    }
    return url;
  }

  async unsubscribe(token: string): Promise<boolean> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { token } });
    if (!r) return false;
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: r.campaignId, workspaceId: r.workspaceId },
      select: { channel: true },
    });
    const field = campaign?.channel === 'EMAIL' ? 'emailOptOut' : campaign?.channel === 'SMS' ? 'smsOptOut' : 'waOptOut';
    await this.prisma.lead.updateMany({ where: { id: r.leadId, workspaceId: r.workspaceId }, data: { [field]: true } });
    if (field === 'smsOptOut') {
      await this.emitSmsOptOutEvent(r.workspaceId, r.leadId, r.id);
    }
    if (r.status !== 'UNSUBSCRIBED') {
      // Race-safe claim: only the first hit flips the status + counts (the opt-out
      // above is idempotent and always runs, so consent is honored regardless).
      const claim = await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, status: { not: 'UNSUBSCRIBED' } },
        data: { status: 'UNSUBSCRIBED' },
      });
      if (claim.count === 1) await this.bump(r.campaignId, 'unsubscribed');
    }
    return true;
  }

  /**
   * Mirrors an SMS unsubscribe onto NetgsmBlacklistSyncService via the outbox
   * (defense-in-depth NetGSM account-blacklist sync — see that service's
   * docstring). Best-effort: the opt-out flag is already durably set above,
   * so a failure enqueueing the follow-on sync event is logged rather than
   * failing the whole unsubscribe request. Keyed on the recipient row id so a
   * retried/duplicate POST of the SAME unsubscribe click collapses into one
   * outbox row.
   */
  private async emitSmsOptOutEvent(workspaceId: string, leadId: string, recipientId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
    if (!lead?.phone) return; // nothing to sync without a phone number
    try {
      await this.outbox.append({
        type: MarketingEventTypes.SmsOptedOut,
        tenantId: null,
        payload: { workspaceId, leadId, phone: lead.phone } satisfies MarketingSmsOptStatusPayload,
        idempotencyKey: `${workspaceId}:${leadId}:${MarketingEventTypes.SmsOptedOut}:unsub:${recipientId}`,
      });
    } catch (e: any) {
      this.logger.warn(`Failed to enqueue ${MarketingEventTypes.SmsOptedOut} for lead=${leadId}: ${e?.message ?? e}`);
    }
  }

  /**
   * Atomically increment one analytics counter in the campaign's JSON stats.
   * A single jsonb_set UPDATE (no read-modify-write), so concurrent open/click
   * pixels across different recipients of the same campaign can't lose
   * increments. `key` is a fixed internal literal (never user input).
   */
  private async bump(
    campaignId: string,
    key: 'opened' | 'clicked' | 'unsubscribed',
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE "campaigns"
         SET "stats" = jsonb_set(
           COALESCE("stats", '{}'::jsonb),
           ARRAY[$1],
           to_jsonb(COALESCE(("stats"->>$1)::int, 0) + 1),
           true)
       WHERE "id" = $2`,
      key,
      campaignId,
    );
  }
}
