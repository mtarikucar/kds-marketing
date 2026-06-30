/**
 * social-planner.service.ts — typed API calls for the social planner
 * feature, extracted from the inline marketingApi.get() calls in the page
 * component so the service boundary is testable in isolation.
 */

import marketingApi from './marketingApi';

export interface TiktokCreatorInfo {
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

/**
 * GET /social-planner/accounts/:id/tiktok/creator-info
 * Returns the creator's allowed privacy options and interaction caps.
 * Throws (via axios) if the account is not found or the token is invalid.
 */
export const getTiktokCreatorInfo = (accountId: string): Promise<TiktokCreatorInfo> =>
  marketingApi
    .get(`/social-planner/accounts/${accountId}/tiktok/creator-info`)
    .then((r) => r.data as TiktokCreatorInfo);
