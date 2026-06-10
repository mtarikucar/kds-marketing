import { CampaignTrackingService } from './campaign-tracking.service';

/**
 * Tracking security: click resolves ONLY to a campaign-authored http(s) link
 * (no open redirect — even if a token is valid), and unsubscribe flips the
 * lead's per-channel opt-out so future sends + the AI engine honor it.
 */
describe('CampaignTrackingService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: CampaignTrackingService;

  beforeEach(() => {
    prisma = {
      campaignRecipient: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      campaign: {
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ stats: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    svc = new CampaignTrackingService(prisma as any);
  });

  it('click returns the campaign-authored URL at the index', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, clickedAt: null });
    prisma.campaign.findFirst.mockResolvedValue({ links: ['https://shop.example/spring'] });
    await expect(svc.click('tok', 0)).resolves.toBe('https://shop.example/spring');
  });

  it('click refuses an out-of-range index (no redirect target)', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, clickedAt: null });
    prisma.campaign.findFirst.mockResolvedValue({ links: ['https://x.com'] });
    await expect(svc.click('tok', 9)).resolves.toBeNull();
  });

  it('click refuses a non-http(s) link (open-redirect guard)', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, clickedAt: null });
    prisma.campaign.findFirst.mockResolvedValue({ links: ['javascript:alert(1)'] });
    await expect(svc.click('tok', 0)).resolves.toBeNull();
  });

  it('click on an unknown token returns null', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue(null);
    await expect(svc.click('nope', 0)).resolves.toBeNull();
  });

  it('unsubscribe flips the channel-specific opt-out, workspace-scoped', async () => {
    prisma.campaignRecipient.findUnique.mockResolvedValue({ id: 'r1', campaignId: 'c1', workspaceId: WS, leadId: 'lead-1', status: 'SENT' });
    prisma.campaign.findFirst.mockResolvedValue({ channel: 'WHATSAPP' });
    await expect(svc.unsubscribe('tok')).resolves.toBe(true);
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS },
      data: { waOptOut: true },
    });
  });
});
