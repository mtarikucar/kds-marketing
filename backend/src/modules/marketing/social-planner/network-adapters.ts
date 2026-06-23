import { Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';

const logger = new Logger('NetworkAdapters');

export interface PublishResult {
  ok: boolean;
  externalPostId?: string;
  error?: string;
}

export interface AccountRow {
  id: string;
  network: string;
  externalId: string;
  accessToken: string; // SEALED
  /** PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK — selects the LinkedIn author URN. */
  accountType?: string | null;
}

/** Returns the access token or null if secret-box not configured / malformed. */
function revealToken(account: AccountRow): string | null {
  try {
    return openSecret(account.accessToken);
  } catch {
    return null;
  }
}

/** True when all required env vars for a network are present. */
export function isNetworkConfigured(network: string): boolean {
  switch (network) {
    case 'FACEBOOK':
    case 'INSTAGRAM':
      return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
    case 'LINKEDIN':
      return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
    case 'TIKTOK':
      return !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
    // Epic 12 (needs-external, inert until creds): X/Twitter, Pinterest, Google
    // Business Profile. Each gates on its own platform app credentials.
    case 'TWITTER':
      return !!(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);
    case 'PINTEREST':
      return !!(process.env.PINTEREST_APP_ID && process.env.PINTEREST_APP_SECRET);
    case 'GMB':
      return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    default:
      return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Publish to Facebook (Graph API /me/feed). */
async function publishFacebook(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('FACEBOOK')) {
    return { ok: false, error: 'Facebook not configured: set META_APP_ID and META_APP_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };

  const body: Record<string, unknown> = { message: content, access_token: token };
  // Attach the first media url as a link if present
  if (mediaUrls.length > 0) body.link = mediaUrls[0];

  try {
    const res = await safeFetch(
      `https://graph.facebook.com/v19.0/${account.externalId}/feed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 15_000,
      },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && json.id) {
      return { ok: true, externalPostId: String(json.id) };
    }
    const err = String((json as any)?.error?.message ?? res.status);
    logger.warn(`Facebook publish failed (${account.externalId}): ${err}`);
    return { ok: false, error: err.slice(0, 500) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Facebook publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** Publish to Instagram (Graph API /me/media + /me/media_publish). */
async function publishInstagram(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('INSTAGRAM')) {
    return { ok: false, error: 'Instagram not configured: set META_APP_ID and META_APP_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };

  try {
    // Step 1: create a media container
    const mediaBody: Record<string, unknown> = {
      caption: content,
      access_token: token,
    };
    if (mediaUrls.length > 0) {
      mediaBody.image_url = mediaUrls[0];
      mediaBody.media_type = 'IMAGE';
    } else {
      // Carousel/text not officially supported without media; use REELS or bail
      return { ok: false, error: 'Instagram requires at least one media URL' };
    }

    const createRes = await safeFetch(
      `https://graph.facebook.com/v19.0/${account.externalId}/media`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mediaBody),
        timeoutMs: 15_000,
      },
    );
    const createJson = (await createRes.json()) as Record<string, unknown>;
    if (!createRes.ok || !createJson.id) {
      const err = String((createJson as any)?.error?.message ?? createRes.status);
      return { ok: false, error: `IG media create: ${err}`.slice(0, 500) };
    }

    // Step 2: publish the container
    const pubRes = await safeFetch(
      `https://graph.facebook.com/v19.0/${account.externalId}/media_publish`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creation_id: createJson.id, access_token: token }),
        timeoutMs: 15_000,
      },
    );
    const pubJson = (await pubRes.json()) as Record<string, unknown>;
    if (pubRes.ok && pubJson.id) {
      return { ok: true, externalPostId: String(pubJson.id) };
    }
    const err2 = String((pubJson as any)?.error?.message ?? pubRes.status);
    return { ok: false, error: `IG media publish: ${err2}`.slice(0, 500) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** Publish to LinkedIn (UGC Posts API). */
async function publishLinkedIn(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('LINKEDIN')) {
    return { ok: false, error: 'LinkedIn not configured: set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };

  const author =
    account.accountType === 'LI_ORG'
      ? `urn:li:organization:${account.externalId}`
      : `urn:li:person:${account.externalId}`;
  const body: Record<string, unknown> = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: content },
        shareMediaCategory: mediaUrls.length > 0 ? 'ARTICLE' : 'NONE',
        ...(mediaUrls.length > 0 ? {
          media: mediaUrls.map((url) => ({
            status: 'READY',
            originalUrl: url,
          })),
        } : {}),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  try {
    const res = await safeFetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && json.id) {
      return { ok: true, externalPostId: String(json.id) };
    }
    const err = String((json as any)?.message ?? res.status);
    logger.warn(`LinkedIn publish failed (${account.externalId}): ${err}`);
    return { ok: false, error: err.slice(0, 500) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`LinkedIn publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/**
 * Publish to TikTok (Content Posting API — Direct Post). TikTok is video-first:
 * it pulls the video from the first media URL, then processes it asynchronously.
 * We init the post and briefly poll the publish status to surface immediate
 * failures; if it's still processing after the bounded wait we report success
 * with the publish_id (TikTok finishes the encode on its side).
 */
async function publishTikTok(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('TIKTOK')) {
    return { ok: false, error: 'TikTok not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  if (mediaUrls.length === 0) {
    return { ok: false, error: 'TikTok requires a video media URL' };
  }

  try {
    // Step 1 — init the post; TikTok pulls the video from the URL.
    const initRes = await safeFetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: content.slice(0, 2200),
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_comment: false,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: mediaUrls[0] },
      }),
      timeoutMs: 15_000,
    });
    const initJson = (await initRes.json()) as Record<string, any>;
    const publishId = initJson?.data?.publish_id;
    if (!initRes.ok || !publishId) {
      const err = String(initJson?.error?.message ?? initJson?.error?.code ?? initRes.status);
      logger.warn(`TikTok publish init failed (${account.externalId}): ${err}`);
      return { ok: false, error: err.slice(0, 500) };
    }

    // Step 2 — bounded status poll (≤10s) to catch immediate rejections.
    for (let i = 0; i < 5; i++) {
      await sleep(2_000);
      const statusRes = await safeFetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id: publishId }),
        timeoutMs: 10_000,
      });
      const statusJson = (await statusRes.json()) as Record<string, any>;
      const status = statusJson?.data?.status;
      if (status === 'PUBLISH_COMPLETE') {
        return { ok: true, externalPostId: String(publishId) };
      }
      if (status === 'FAILED') {
        const reason = String(statusJson?.data?.fail_reason ?? 'TikTok rejected the video');
        return { ok: false, error: reason.slice(0, 500) };
      }
    }
    // Still processing after the bounded wait — treat as accepted (queued).
    return { ok: true, externalPostId: String(publishId) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`TikTok publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** Publish to X/Twitter (API v2 POST /2/tweets). Inert without a paid X app. */
async function publishTwitter(
  account: AccountRow,
  content: string,
  _mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('TWITTER')) {
    return { ok: false, error: 'X/Twitter not configured: set X_CLIENT_ID and X_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  // Media upload uses the separate v1.1 endpoint (chunked) — text-only for now;
  // attaching media is a follow-up once a paid X app is connected.
  try {
    const res = await safeFetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: content.slice(0, 280) }),
      timeoutMs: 15_000,
    });
    const json = (await res.json()) as Record<string, any>;
    const id = json?.data?.id;
    if (res.ok && id) return { ok: true, externalPostId: String(id) };
    const err = String(json?.detail ?? json?.title ?? res.status);
    logger.warn(`Twitter publish failed (${account.externalId}): ${err}`);
    return { ok: false, error: err.slice(0, 500) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Twitter publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** Publish to Pinterest (API v5 POST /pins). board_id is the account externalId. */
async function publishPinterest(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('PINTEREST')) {
    return { ok: false, error: 'Pinterest not configured: set PINTEREST_APP_ID and PINTEREST_APP_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  if (mediaUrls.length === 0) return { ok: false, error: 'Pinterest requires an image media URL' };
  try {
    const res = await safeFetch('https://api.pinterest.com/v5/pins', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        board_id: account.externalId,
        description: content.slice(0, 800),
        media_source: { source_type: 'image_url', url: mediaUrls[0] },
      }),
      timeoutMs: 15_000,
    });
    const json = (await res.json()) as Record<string, any>;
    if (res.ok && json?.id) return { ok: true, externalPostId: String(json.id) };
    const err = String(json?.message ?? res.status);
    logger.warn(`Pinterest publish failed (${account.externalId}): ${err}`);
    return { ok: false, error: err.slice(0, 500) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Pinterest publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/**
 * Publish to Google Business Profile (Local Post). externalId is the location id
 * `accounts/{a}/locations/{l}`. Inert until Google allowlists the Business
 * Profile API. Builds a Local Post only (GBP messaging is sunset).
 */
async function publishGmb(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('GMB')) {
    return { ok: false, error: 'Google Business Profile not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  try {
    const body: Record<string, unknown> = {
      languageCode: 'tr',
      summary: content.slice(0, 1500),
      topicType: 'STANDARD',
      ...(mediaUrls.length > 0 ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrls[0] }] } : {}),
    };
    const res = await safeFetch(
      `https://mybusiness.googleapis.com/v4/${account.externalId}/localPosts`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 15_000,
      },
    );
    const json = (await res.json()) as Record<string, any>;
    if (res.ok && json?.name) return { ok: true, externalPostId: String(json.name) };
    const err = String(json?.error?.message ?? res.status);
    logger.warn(`GMB publish failed (${account.externalId}): ${err}`);
    return { ok: false, error: err.slice(0, 500) };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`GMB publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/** Dispatch to the correct per-network adapter. */
export async function publishToNetwork(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  switch (account.network) {
    case 'FACEBOOK':
      return publishFacebook(account, content, mediaUrls);
    case 'INSTAGRAM':
      return publishInstagram(account, content, mediaUrls);
    case 'LINKEDIN':
      return publishLinkedIn(account, content, mediaUrls);
    case 'TIKTOK':
      return publishTikTok(account, content, mediaUrls);
    case 'TWITTER':
      return publishTwitter(account, content, mediaUrls);
    case 'PINTEREST':
      return publishPinterest(account, content, mediaUrls);
    case 'GMB':
      return publishGmb(account, content, mediaUrls);
    default:
      return { ok: false, error: `Unknown network: ${account.network}` };
  }
}
