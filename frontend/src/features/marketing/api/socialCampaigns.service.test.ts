import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('./marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

import {
  listSocialCampaigns,
  createSocialCampaign,
  setCampaignLifecycle,
  listSocialCampaignItems,
  confirmSocialCampaignPlan,
  reviewSocialCampaignItem,
  type SocialCampaignPayload,
} from './socialCampaigns.service';

describe('socialCampaigns.service', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); patch.mockReset(); });

  it('lists campaigns from /social-campaigns', async () => {
    get.mockResolvedValue({ data: [{ id: 'sc1' }] });
    const res = await listSocialCampaigns();
    expect(get).toHaveBeenCalledWith('/social-campaigns');
    expect(res).toEqual([{ id: 'sc1' }]);
  });

  it('creates a campaign, forwarding linkedCampaignId for the cross-link', async () => {
    post.mockResolvedValue({ data: { id: 'sc2' } });
    const payload: SocialCampaignPayload = {
      name: 'Launch',
      automationMode: 'APPROVAL',
      planningMode: 'AI_PROPOSE',
      cadence: { perWeek: 3, daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'Europe/Istanbul' },
      startDate: '2026-07-01',
      targetAccountIds: ['a1'],
      mediaKinds: ['IMAGE'],
      linkedCampaignId: 'c1',
    };
    const res = await createSocialCampaign(payload);
    expect(post).toHaveBeenCalledWith('/social-campaigns', payload);
    expect(res).toEqual({ id: 'sc2' });
  });

  it('posts lifecycle actions to /:id/:action', async () => {
    post.mockResolvedValue({ data: { id: 'sc1', status: 'ACTIVE' } });
    await setCampaignLifecycle('sc1', 'activate');
    expect(post).toHaveBeenCalledWith('/social-campaigns/sc1/activate');
  });

  it('confirms a proposed plan and lists/reviews items', async () => {
    get.mockResolvedValue({ data: [{ id: 'it1' }] });
    await listSocialCampaignItems('sc1');
    expect(get).toHaveBeenCalledWith('/social-campaigns/sc1/items');

    post.mockResolvedValue({ data: { message: 'ok' } });
    await confirmSocialCampaignPlan('sc1');
    expect(post).toHaveBeenCalledWith('/social-campaigns/sc1/plan/confirm');

    post.mockResolvedValue({ data: { id: 'it1', status: 'APPROVED' } });
    await reviewSocialCampaignItem('it1', 'approve');
    expect(post).toHaveBeenCalledWith('/social-campaigns/items/it1/approve');
  });
});
