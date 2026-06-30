// tiktok-creator-info.util.ts
import { safeFetch } from '../../../common/util/safe-fetch';

export interface TiktokCreatorInfo {
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

/** Query the creator's allowed post options (consumer Content Posting API). */
export async function queryCreatorInfo(accessToken: string): Promise<TiktokCreatorInfo> {
  const res = await safeFetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    timeoutMs: 15_000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || json?.error?.code === 'access_token_invalid') {
    throw new Error(String(json?.error?.message ?? `creator_info HTTP ${res.status}`));
  }
  const d = json?.data ?? {};
  return {
    privacyLevelOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : ['SELF_ONLY'],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxVideoPostDurationSec: Number(d.max_video_post_duration_sec ?? 0),
  };
}

/** Force the requested privacy level into what the account actually allows. */
export function validatePrivacyLevel(requested: string | undefined, info: TiktokCreatorInfo): string {
  if (requested && info.privacyLevelOptions.includes(requested)) return requested;
  return info.privacyLevelOptions[0] ?? 'SELF_ONLY';
}
