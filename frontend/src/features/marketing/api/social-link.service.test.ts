import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { post: vi.fn() },
}));
import marketingApi from './marketingApi';
import { provisionSocialFromCampaign } from './social-link.service';

const post = marketingApi.post as unknown as ReturnType<typeof vi.fn>;

describe('social-link.service', () => {
  beforeEach(() => post.mockReset());

  it('provisionSocialFromCampaign posts to the campaign social route', async () => {
    post.mockResolvedValue({ data: { socialCampaignId: 'sc-1' } });
    const out = await provisionSocialFromCampaign('camp-1');
    expect(out).toEqual({ socialCampaignId: 'sc-1' });
    expect(post).toHaveBeenCalledWith('/campaigns/camp-1/social');
  });
});
