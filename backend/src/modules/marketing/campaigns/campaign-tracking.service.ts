import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Resolves the unguessable per-recipient token behind open/click/unsubscribe
 * links and records the event. Click only ever returns a URL that was in the
 * campaign body at launch (Campaign.links), so the tracker can't be turned into
 * an open redirect. Unsubscribe flips the lead's per-channel opt-out so future
 * campaigns AND the AI engine honor it.
 */
@Injectable()
export class CampaignTrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async open(token: string): Promise<void> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { token } });
    if (!r || r.openedAt) return;
    await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { openedAt: new Date() } });
    await this.bump(r.campaignId, 'opened');
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
      await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { clickedAt: new Date() } });
      await this.bump(r.campaignId, 'clicked');
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
    if (r.status !== 'UNSUBSCRIBED') {
      await this.prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'UNSUBSCRIBED' } });
      await this.bump(r.campaignId, 'unsubscribed');
    }
    return true;
  }

  private async bump(campaignId: string, key: string): Promise<void> {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { stats: true } });
    const s = (c?.stats ?? {}) as Record<string, number>;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { stats: { ...s, [key]: (s[key] ?? 0) + 1 } as Prisma.InputJsonValue },
    });
  }
}
