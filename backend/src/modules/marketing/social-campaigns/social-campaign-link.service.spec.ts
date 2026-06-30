import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialCampaignLinkService } from './social-campaign-link.service';

describe('SocialCampaignLinkService.provisionFromBlast', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: SocialCampaignLinkService;

  beforeEach(() => {
    prisma = {
      campaign: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      socialCampaign: {
        create: jest.fn().mockResolvedValue({ id: 'sc-9' }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    svc = new SocialCampaignLinkService(prisma as any);
  });

  it('maps subject/body/audienceFilter into a DRAFT social campaign and back-links the blast', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'camp-1',
      workspaceId: WS,
      name: 'Summer Promo',
      subject: 'Big summer sale',
      body: 'Get 20% off everything this week only.',
      channel: 'email',
      audienceFilter: [{ field: 'city', op: 'eq', value: 'Istanbul' }],
      socialCampaignId: null,
    });

    const out = await svc.provisionFromBlast(WS, 'camp-1', 'user-7');

    expect(out).toEqual({ socialCampaignId: 'sc-9' });
    const data = prisma.socialCampaign.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe(WS);
    expect(data.name).toContain('Summer Promo');
    expect(data.linkedCampaignId).toBe('camp-1');
    expect(data.status).toBe('DRAFT');
    expect(data.createdById).toBe('user-7');
    expect(data.brief.audience).toEqual([{ field: 'city', op: 'eq', value: 'Istanbul' }]);
    expect(data.brief.keyMessages[0]).toContain('20% off');
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { socialCampaignId: 'sc-9' },
    });
  });

  it('rejects when the campaign is missing', async () => {
    prisma.campaign.findFirst.mockResolvedValue(null);
    await expect(svc.provisionFromBlast(WS, 'nope', 'u')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a campaign already linked', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'camp-1', workspaceId: WS, name: 'X', body: 'b', socialCampaignId: 'sc-prev' });
    await expect(svc.provisionFromBlast(WS, 'camp-1', 'u')).rejects.toBeInstanceOf(BadRequestException);
  });
});
