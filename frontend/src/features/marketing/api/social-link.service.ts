/**
 * social-link.service.ts — typed FE API for the Campaigns ↔ Social cross-link
 * (AI Social Content Studio §9). Provisions a Social Campaign from an existing
 * blast campaign via the dedicated server-side prefill endpoint.
 *
 * Note: the Meta creative-push surface (`pushAssetToMetaAd`) is intentionally
 * omitted on this branch — the ad-management backend lives on a separate,
 * unmerged epic.
 */
import marketingApi from './marketingApi';

export const provisionSocialFromCampaign = (
  campaignId: string,
): Promise<{ socialCampaignId: string }> =>
  marketingApi.post(`/campaigns/${campaignId}/social`).then((r) => r.data);
