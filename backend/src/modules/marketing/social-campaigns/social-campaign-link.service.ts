import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Cross-linkage between blast Campaigns and the AI Social Content Studio
 * (design §6.3): provision a companion SocialCampaign prefilled from a blast.
 *
 * NOTE — the Meta-ads creative push (§6.3, "push a generated asset to a Meta ad")
 * is deliberately NOT implemented here: it depends on the ad-management layer
 * (`AdManagementService` / `meta-ads-management.client`) that lives on a separate,
 * not-yet-merged ads epic. It will be added when that layer reaches `main`, so
 * this base branch does not fork a divergent duplicate of it.
 */
@Injectable()
export class SocialCampaignLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async provisionFromBlast(
    workspaceId: string,
    campaignId: string,
    createdById: string,
  ): Promise<{ socialCampaignId: string }> {
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.socialCampaignId) {
      throw new BadRequestException('Campaign already linked to a social campaign');
    }

    const excerpt = (campaign.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const brief: Prisma.InputJsonValue = {
      audience: (campaign.audienceFilter ?? []) as Prisma.InputJsonValue,
      keyMessages: excerpt ? [excerpt] : [],
      sourceCampaignId: campaign.id,
      sourceChannel: campaign.channel,
      languages: ['tr'],
    };

    const created = await this.prisma.$transaction(async (tx) => {
      const sc = await tx.socialCampaign.create({
        data: {
          workspaceId,
          name: `${campaign.name} — Social`,
          goal: campaign.subject ?? campaign.name,
          theme: campaign.subject ?? null,
          brief,
          status: 'DRAFT',
          automationMode: 'APPROVAL',
          planningMode: 'AI_PROPOSE',
          cadence: { perWeek: 3, daysOfWeek: [1, 3, 5], timeOfDay: '10:00', timezone: 'Europe/Istanbul' },
          startDate: new Date(),
          targetAccountIds: [],
          mediaKinds: ['IMAGE', 'VIDEO'],
          dailyPublishCap: 2,
          linkedCampaignId: campaign.id,
          createdById,
        },
        select: { id: true },
      });
      // Conditional link: only set socialCampaignId if it is still null. If a
      // concurrent provision already linked the blast, count is 0 → throw, which
      // rolls back the SocialCampaign we just created (no orphan). The check-then-
      // act guard above is a fast path; this is the race-safe backstop.
      const linked = await tx.campaign.updateMany({
        where: { id: campaign.id, workspaceId, socialCampaignId: null },
        data: { socialCampaignId: sc.id },
      });
      if (linked.count !== 1) {
        throw new BadRequestException('Campaign already linked to a social campaign');
      }
      return sc;
    });

    return { socialCampaignId: created.id };
  }
}
