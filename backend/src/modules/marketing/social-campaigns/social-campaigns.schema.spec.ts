import {
  Prisma,
  SocialCampaignStatus,
  SocialCampaignAutomationMode,
  SocialCampaignPlanningMode,
  SocialCampaignItemStatus,
} from '@prisma/client';

describe('Social Campaign schema', () => {
  it('exposes the new models', () => {
    expect(Prisma.ModelName.SocialCampaign).toBe('SocialCampaign');
    expect(Prisma.ModelName.SocialCampaignItem).toBe('SocialCampaignItem');
  });
  it('exposes the new enums', () => {
    expect(SocialCampaignStatus.ACTIVE).toBe('ACTIVE');
    expect(SocialCampaignAutomationMode.FULL_AUTO).toBe('FULL_AUTO');
    expect(SocialCampaignPlanningMode.AI_PROPOSE).toBe('AI_PROPOSE');
    expect(SocialCampaignItemStatus.NEEDS_APPROVAL).toBe('NEEDS_APPROVAL');
  });
});
