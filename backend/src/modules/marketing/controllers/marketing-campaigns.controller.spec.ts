import { MarketingCampaignsController } from './marketing-campaigns.controller';

describe('MarketingCampaignsController.createSocial', () => {
  it('provisions a social campaign from the blast using the caller id', async () => {
    const campaigns = {} as any;
    const link = { provisionFromBlast: jest.fn().mockResolvedValue({ socialCampaignId: 'sc-1' }) } as any;
    const ctrl = new MarketingCampaignsController(campaigns, link);
    const user = { id: 'u-7', workspaceId: 'ws-1' } as any;

    const out = await ctrl.createSocial(user, 'camp-1');

    expect(out).toEqual({ socialCampaignId: 'sc-1' });
    expect(link.provisionFromBlast).toHaveBeenCalledWith('ws-1', 'camp-1', 'u-7');
  });
});
