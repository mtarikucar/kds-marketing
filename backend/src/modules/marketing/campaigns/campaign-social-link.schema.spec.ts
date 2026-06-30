import { readFileSync } from 'fs';
import { join } from 'path';

describe('Campaign.socialCampaignId schema column', () => {
  const schema = readFileSync(
    join(__dirname, '../../../../prisma/schema.prisma'),
    'utf8',
  );
  const campaignBlock = schema.slice(
    schema.indexOf('model Campaign {'),
    schema.indexOf('@@map("campaigns")'),
  );

  it('declares a nullable socialCampaignId on the blast Campaign model', () => {
    expect(campaignBlock).toMatch(/socialCampaignId\s+String\?/);
  });
});
