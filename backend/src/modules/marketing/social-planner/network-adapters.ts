import { Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isGoogleOAuthConfigured } from '../../../common/util/google-oauth-env';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';
import { queryCreatorInfo, validatePrivacyLevel } from './tiktok-creator-info.util';

export interface TikTokPostOptions {
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  mediaType?: 'VIDEO' | 'PHOTO';
  coverIndex?: number;
}
export interface PublishOptions {
  tiktok?: TikTokPostOptions;
}

const logger = new Logger('NetworkAdapters');

export interface PublishResult {
  ok: boolean;
  externalPostId?: string;
  error?: string;
  /** True when the failure is a Meta token problem needing reconnect. */
  isAuthError?: boolean;
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
      return isGoogleOAuthConfigured();
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

  const body: Record<string, unknown> = { message: content };
  // Attach the first media url as a link if present
  if (mediaUrls.length > 0) body.link = mediaUrls[0];

  try {
    const r = await metaGraphFetch(`/${account.externalId}/feed`, {
      accessToken: token,
      method: 'POST',
      body,
      timeoutMs: 15_000,
    });
    if (!r.ok) {
      logger.warn(`Facebook publish failed (${account.externalId}): ${r.error.message}`);
      return { ok: false, error: r.error.message.slice(0, 500), isAuthError: r.error.isAuthError };
    }
    const id = (r.data as any)?.id;
    if (id) return { ok: true, externalPostId: String(id) };
    logger.warn(`Facebook publish failed (${account.externalId}): no post id returned`);
    return { ok: false, error: 'no post id returned' };
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
    const mediaBody: Record<string, unknown> = { caption: content };
    if (mediaUrls.length > 0) {
      mediaBody.image_url = mediaUrls[0];
      mediaBody.media_type = 'IMAGE';
    } else {
      // Carousel/text not officially supported without media; use REELS or bail
      return { ok: false, error: 'Instagram requires at least one media URL' };
    }

    const createRes = await metaGraphFetch(`/${account.externalId}/media`, {
      accessToken: token,
      method: 'POST',
      body: mediaBody,
      timeoutMs: 15_000,
    });
    if (!createRes.ok) {
      return {
        ok: false,
        error: `IG media create: ${createRes.error.message}`.slice(0, 500),
        isAuthError: createRes.error.isAuthError,
      };
    }
    const containerId = (createRes.data as any)?.id;
    if (!containerId) {
      return { ok: false, error: 'IG media create: no container id returned' };
    }

    // Step 2: publish the container
    const pubRes = await metaGraphFetch(`/${account.externalId}/media_publish`, {
      accessToken: token,
      method: 'POST',
      body: { creation_id: containerId },
      timeoutMs: 15_000,
    });
    if (!pubRes.ok) {
      return {
        ok: false,
        error: `IG media publish: ${pubRes.error.message}`.slice(0, 500),
        isAuthError: pubRes.error.isAuthError,
      };
    }
    const postId = (pubRes.data as any)?.id;
    if (postId) return { ok: true, externalPostId: String(postId) };
    return { ok: false, error: 'IG media publish: no post id returned' };
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
 *
 * Supports per-post privacy/interaction controls and photo/carousel posts via
 * the optional `options` arg. Creator-info is queried first to clip the
 * requested privacy level to what the account actually allows.
 */
async function publishTikTok(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
  options?: TikTokPostOptions,
): Promise<PublishResult> {
  if (!isNetworkConfigured('TIKTOK')) {
    return { ok: false, error: 'TikTok not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  if (mediaUrls.length === 0) {
    return { ok: false, error: 'TikTok requires at least one media URL' };
  }

  try {
    // Step 0 — creator info governs the allowed privacy options + interaction caps.
    const info = await queryCreatorInfo(token);
    const privacy = validatePrivacyLevel(options?.privacyLevel, info);
    const isPhoto = options?.mediaType === 'PHOTO';

    let initUrl: string;
    let initBody: Record<string, any>;
    if (isPhoto) {
      initUrl = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
      initBody = {
        media_type: 'PHOTO',
        post_mode: 'DIRECT_POST',
        post_info: {
          title: content.slice(0, 90),
          description: content.slice(0, 4000),
          privacy_level: privacy,
          disable_comment: options?.disableComment ?? info.commentDisabled,
        },
        // TikTok's content/init contract puts the image URLs + cover index in
        // source_info (NOT post_info) alongside the PULL_FROM_URL source.
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: Math.min(options?.coverIndex ?? 0, mediaUrls.length - 1),
          photo_images: mediaUrls.slice(0, 35),
        },
      };
    } else {
      initUrl = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
      initBody = {
        post_info: {
          title: content.slice(0, 2200),
          privacy_level: privacy,
          disable_comment: options?.disableComment ?? info.commentDisabled,
          disable_duet: options?.disableDuet ?? info.duetDisabled,
          disable_stitch: options?.disableStitch ?? info.stitchDisabled,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: mediaUrls[0] },
      };
    }

    const initRes = await safeFetch(initUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(initBody),
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
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ publish_id: publishId }),
        timeoutMs: 10_000,
      });
      const statusJson = (await statusRes.json()) as Record<string, any>;
      const status = statusJson?.data?.status;
      if (status === 'PUBLISH_COMPLETE') return { ok: true, externalPostId: String(publishId) };
      if (status === 'FAILED') {
        const reason = String(statusJson?.data?.fail_reason ?? 'TikTok rejected the media');
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

// X allows up to 4 images per tweet; bound the upload work accordingly.
const X_MAX_MEDIA = 4;
const X_MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — X's per-image image limit.

/**
 * Read a response body into a Buffer, streaming with a hard cap: as soon as the
 * accumulated size would EXCEED maxBytes, cancel the stream and return null (the
 * image is over the limit). Never buffers the whole body first.
 */
async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer | null> {
  const body = (res as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) return null; // over cap — stop, don't buffer the rest
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Upload one image URL to X's v2 media endpoint (OAuth2 user context, scope
 * media.write) and return its media id. Fetches the bytes SSRF-guarded, caps
 * the size, and posts multipart/form-data. Returns null on any failure (the
 * caller degrades to a text-only tweet rather than failing the whole post).
 */
async function uploadXMedia(token: string, mediaUrl: string): Promise<string | null> {
  try {
    const imgRes = await safeFetch(mediaUrl, { method: 'GET', timeoutMs: 15_000 });
    if (!imgRes.ok) return null;
    // Stream with a hard byte cap and abort once exceeded — never buffer the whole
    // (caller-supplied) body into one arrayBuffer() allocation, which a hostile/
    // misbehaving host could make multi-GB within the timeout (OOM on the worker).
    const buf = await readCappedBytes(imgRes, X_MEDIA_MAX_BYTES);
    if (!buf || buf.length === 0) return null;
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const form = new FormData();
    // Wrap in a fresh Uint8Array so the Blob part is ArrayBuffer-backed (Buffer.concat
    // yields an ArrayBufferLike that the Blob constructor's types reject).
    form.append('media', new Blob([new Uint8Array(buf)], { type: contentType }), 'media');
    form.append('media_category', 'tweet_image');
    const upRes = await safeFetch('https://api.x.com/2/media/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // let fetch set the multipart boundary
      body: form,
      timeoutMs: 30_000,
    });
    const json = (await upRes.json()) as Record<string, any>;
    // v2 returns { data: { id } }; tolerate the legacy media_id_string too.
    const id = json?.data?.id ?? json?.media_id_string;
    if (upRes.ok && id) return String(id);
    logger.warn(`X media upload failed: ${String(json?.detail ?? json?.title ?? upRes.status)}`);
    return null;
  } catch (e: any) {
    logger.warn(`X media upload error: ${e?.message ?? String(e)}`);
    return null;
  }
}

/** Publish to X/Twitter (API v2 POST /2/tweets), with image media. Inert without a paid X app. */
async function publishTwitter(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('TWITTER')) {
    return { ok: false, error: 'X/Twitter not configured: set X_CLIENT_ID and X_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  try {
    // Upload up to 4 images first (best-effort); a media failure degrades to a
    // text-only tweet rather than dropping the whole post.
    const mediaIds: string[] = [];
    for (const url of mediaUrls.slice(0, X_MAX_MEDIA)) {
      const id = await uploadXMedia(token, url);
      if (id) mediaIds.push(id);
    }
    const body: Record<string, unknown> = { text: content.slice(0, 280) };
    if (mediaIds.length > 0) body.media = { media_ids: mediaIds };

    const res = await safeFetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
  options?: PublishOptions,
): Promise<PublishResult> {
  switch (account.network) {
    case 'FACEBOOK':
      return publishFacebook(account, content, mediaUrls);
    case 'INSTAGRAM':
      return publishInstagram(account, content, mediaUrls);
    case 'LINKEDIN':
      return publishLinkedIn(account, content, mediaUrls);
    case 'TIKTOK':
      return publishTikTok(account, content, mediaUrls, options?.tiktok);
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
