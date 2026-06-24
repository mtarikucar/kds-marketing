import { Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isGoogleOAuthConfigured } from '../../../common/util/google-oauth-env';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';
import { linkedinRest, linkedinUpload, isLinkedinAuthError } from '../../../common/util/linkedin-api.util';

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

/** Post format selectable per target. Meta (FB/IG) honours all three; the other
 *  networks ignore it and always behave as FEED. */
export type PostFormat = 'FEED' | 'REEL' | 'STORY';

export interface MediaItem {
  url: string;
  /** MIME type (from upload). Falls back to URL extension when absent. */
  mime?: string;
}

/** LinkedIn-specific publish options (organic feed posts). */
export interface LinkedinPostOptions {
  /** Feed visibility for /rest/posts. Defaults to PUBLIC when unset. */
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

export interface PublishOptions {
  format?: PostFormat;
  /** Per-item MIME, parallel to mediaUrls — lets adapters pick image vs video. */
  mediaMime?: (string | undefined)[];
  /** LinkedIn organic post options (visibility). Honoured only by the LINKEDIN adapter. */
  linkedin?: LinkedinPostOptions;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|qt)(?:[?#]|$)/i;
function isVideoItem(item: MediaItem): boolean {
  if (item.mime) return item.mime.toLowerCase().startsWith('video/');
  return VIDEO_EXT.test(item.url);
}
function toMediaItems(mediaUrls: string[], opts: PublishOptions): MediaItem[] {
  return (mediaUrls || []).map((url, i) => ({ url, mime: opts.mediaMime?.[i] }));
}

// ───────────────────────────────────────────────────────── Instagram helpers

/** Create an IG media container (`/{ig}/media`). Returns the container id. */
async function igCreateContainer(
  igId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id?: string; error?: string; isAuthError?: boolean }> {
  const r = await metaGraphFetch(`/${igId}/media`, {
    accessToken: token,
    method: 'POST',
    body,
    timeoutMs: 20_000,
  });
  if (!r.ok) return { error: `IG container: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
  const id = (r.data as any)?.id;
  return id ? { id: String(id) } : { error: 'IG container: no id returned' };
}

/** Poll a container (video/reel/story/carousel) until it finishes processing. */
async function igWaitContainerReady(
  containerId: string,
  token: string,
): Promise<{ ok: boolean; error?: string; isAuthError?: boolean }> {
  for (let i = 0; i < 30; i++) {
    const r = await metaGraphFetch(`/${containerId}`, {
      accessToken: token,
      query: { fields: 'status_code,status' },
      timeoutMs: 15_000,
    });
    if (!r.ok) return { ok: false, error: `IG status: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
    const code = (r.data as any)?.status_code;
    if (code === 'FINISHED') return { ok: true };
    if (code === 'ERROR' || code === 'EXPIRED') {
      return { ok: false, error: `IG processing ${code}: ${(r.data as any)?.status ?? ''}`.slice(0, 300) };
    }
    await sleep(3000);
  }
  return { ok: false, error: 'IG media processing timed out' };
}

/** Publish a finished container (`/{ig}/media_publish`). */
async function igPublish(igId: string, token: string, creationId: string): Promise<PublishResult> {
  const r = await metaGraphFetch(`/${igId}/media_publish`, {
    accessToken: token,
    method: 'POST',
    body: { creation_id: creationId },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, error: `IG publish: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
  const id = (r.data as any)?.id;
  return id ? { ok: true, externalPostId: String(id) } : { ok: false, error: 'IG publish: no id returned' };
}

/**
 * Publish to Instagram (Graph API container flow) — FEED (single image, single
 * video→Reel, or 2–10 carousel), REEL, or STORY (image/video). Videos are
 * polled to FINISHED before publishing.
 */
async function publishInstagram(
  account: AccountRow,
  content: string,
  items: MediaItem[],
  format: PostFormat,
): Promise<PublishResult> {
  if (!isNetworkConfigured('INSTAGRAM')) {
    return { ok: false, error: 'Instagram not configured: set META_APP_ID and META_APP_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  const igId = account.externalId;
  if (items.length === 0) return { ok: false, error: 'Instagram requires at least one media item' };

  try {
    if (format === 'STORY') {
      const m = items[0];
      const body = isVideoItem(m)
        ? { media_type: 'STORIES', video_url: m.url }
        : { media_type: 'STORIES', image_url: m.url };
      const c = await igCreateContainer(igId, token, body);
      if (!c.id) return { ok: false, error: c.error, isAuthError: c.isAuthError };
      if (isVideoItem(m)) {
        const w = await igWaitContainerReady(c.id, token);
        if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
      }
      return igPublish(igId, token, c.id);
    }

    if (format === 'REEL') {
      const vid = items.find(isVideoItem) ?? items[0];
      if (!isVideoItem(vid)) return { ok: false, error: 'Instagram Reels requires a video' };
      const c = await igCreateContainer(igId, token, {
        media_type: 'REELS',
        video_url: vid.url,
        caption: content,
        share_to_feed: true,
      });
      if (!c.id) return { ok: false, error: c.error, isAuthError: c.isAuthError };
      const w = await igWaitContainerReady(c.id, token);
      if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
      return igPublish(igId, token, c.id);
    }

    // FEED
    if (items.length === 1) {
      const m = items[0];
      if (isVideoItem(m)) {
        // Standalone feed video is published as a Reel (Meta deprecated VIDEO).
        const c = await igCreateContainer(igId, token, {
          media_type: 'REELS',
          video_url: m.url,
          caption: content,
          share_to_feed: true,
        });
        if (!c.id) return { ok: false, error: c.error, isAuthError: c.isAuthError };
        const w = await igWaitContainerReady(c.id, token);
        if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
        return igPublish(igId, token, c.id);
      }
      const c = await igCreateContainer(igId, token, { image_url: m.url, caption: content });
      if (!c.id) return { ok: false, error: c.error, isAuthError: c.isAuthError };
      return igPublish(igId, token, c.id);
    }

    // CAROUSEL (2–10 items)
    const children: string[] = [];
    for (const m of items.slice(0, 10)) {
      const childBody = isVideoItem(m)
        ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true }
        : { image_url: m.url, is_carousel_item: true };
      const child = await igCreateContainer(igId, token, childBody);
      if (!child.id) return { ok: false, error: child.error, isAuthError: child.isAuthError };
      if (isVideoItem(m)) {
        const w = await igWaitContainerReady(child.id, token);
        if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
      }
      children.push(child.id);
    }
    const parent = await igCreateContainer(igId, token, {
      media_type: 'CAROUSEL',
      caption: content,
      children: children.join(','),
    });
    if (!parent.id) return { ok: false, error: parent.error, isAuthError: parent.isAuthError };
    const w = await igWaitContainerReady(parent.id, token);
    if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
    return igPublish(igId, token, parent.id);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram publish error (${igId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

// ───────────────────────────────────────────────────────── Facebook helpers

/** Start a resumable video upload (Reels/Stories): returns video_id + upload_url. */
async function fbVideoPhaseStart(
  pageId: string,
  token: string,
  edge: 'video_reels' | 'video_stories',
): Promise<{ videoId?: string; uploadUrl?: string; error?: string; isAuthError?: boolean }> {
  const r = await metaGraphFetch(`/${pageId}/${edge}`, {
    accessToken: token,
    method: 'POST',
    query: { upload_phase: 'start' },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { error: `FB ${edge} start: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
  return {
    videoId: (r.data as any)?.video_id ? String((r.data as any).video_id) : undefined,
    uploadUrl: (r.data as any)?.upload_url,
  };
}

/** Hosted upload: tell the rupload host to pull the video from a public URL. */
async function fbUploadByUrl(
  uploadUrl: string,
  token: string,
  fileUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await safeFetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}`, file_url: fileUrl },
      timeoutMs: 120_000,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `FB upload: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}` };
    if (json && json.success === false) return { ok: false, error: 'FB upload: rejected by host' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `FB upload: ${e?.message ?? e}` };
  }
}

/**
 * Publish to a Facebook Page — FEED (text / single photo / single video /
 * multi-photo), REEL (resumable video upload), or STORY (photo or video).
 */
async function publishFacebook(
  account: AccountRow,
  content: string,
  items: MediaItem[],
  format: PostFormat,
): Promise<PublishResult> {
  if (!isNetworkConfigured('FACEBOOK')) {
    return { ok: false, error: 'Facebook not configured: set META_APP_ID and META_APP_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  const pageId = account.externalId;

  try {
    if (format === 'REEL') {
      const vid = items.find(isVideoItem) ?? items[0];
      if (!vid || !isVideoItem(vid)) return { ok: false, error: 'Facebook Reels requires a video' };
      const start = await fbVideoPhaseStart(pageId, token, 'video_reels');
      if (!start.videoId || !start.uploadUrl) {
        return { ok: false, error: start.error ?? 'FB reels start failed', isAuthError: start.isAuthError };
      }
      const up = await fbUploadByUrl(start.uploadUrl, token, vid.url);
      if (!up.ok) return { ok: false, error: up.error };
      const fin = await metaGraphFetch(`/${pageId}/video_reels`, {
        accessToken: token,
        method: 'POST',
        query: { upload_phase: 'finish', video_id: start.videoId, video_state: 'PUBLISHED' },
        body: { description: content },
        timeoutMs: 30_000,
      });
      if (!fin.ok) return { ok: false, error: `FB reels finish: ${fin.error.message}`.slice(0, 500), isAuthError: fin.error.isAuthError };
      return { ok: true, externalPostId: start.videoId };
    }

    if (format === 'STORY') {
      const m = items[0];
      if (!m) return { ok: false, error: 'Facebook Story requires a media item' };
      if (isVideoItem(m)) {
        const start = await fbVideoPhaseStart(pageId, token, 'video_stories');
        if (!start.videoId || !start.uploadUrl) {
          return { ok: false, error: start.error ?? 'FB story start failed', isAuthError: start.isAuthError };
        }
        const up = await fbUploadByUrl(start.uploadUrl, token, m.url);
        if (!up.ok) return { ok: false, error: up.error };
        const fin = await metaGraphFetch(`/${pageId}/video_stories`, {
          accessToken: token,
          method: 'POST',
          query: { upload_phase: 'finish', video_id: start.videoId },
          timeoutMs: 30_000,
        });
        if (!fin.ok) return { ok: false, error: `FB story finish: ${fin.error.message}`.slice(0, 500), isAuthError: fin.error.isAuthError };
        const pid = (fin.data as any)?.post_id;
        return { ok: true, externalPostId: pid ? String(pid) : start.videoId };
      }
      // Photo story: upload unpublished photo, then attach it as a story.
      const photo = await metaGraphFetch(`/${pageId}/photos`, {
        accessToken: token,
        method: 'POST',
        body: { url: m.url, published: false },
        timeoutMs: 20_000,
      });
      if (!photo.ok) return { ok: false, error: `FB story photo: ${photo.error.message}`.slice(0, 500), isAuthError: photo.error.isAuthError };
      const photoId = (photo.data as any)?.id;
      if (!photoId) return { ok: false, error: 'FB story photo: no id returned' };
      const st = await metaGraphFetch(`/${pageId}/photo_stories`, {
        accessToken: token,
        method: 'POST',
        body: { photo_id: String(photoId) },
        timeoutMs: 20_000,
      });
      if (!st.ok) return { ok: false, error: `FB photo_stories: ${st.error.message}`.slice(0, 500), isAuthError: st.error.isAuthError };
      const pid = (st.data as any)?.post_id;
      return { ok: true, externalPostId: pid ? String(pid) : String(photoId) };
    }

    // FEED
    if (items.length === 0) {
      const r = await metaGraphFetch(`/${pageId}/feed`, {
        accessToken: token,
        method: 'POST',
        body: { message: content },
        timeoutMs: 15_000,
      });
      if (!r.ok) return { ok: false, error: r.error.message.slice(0, 500), isAuthError: r.error.isAuthError };
      const id = (r.data as any)?.id;
      return id ? { ok: true, externalPostId: String(id) } : { ok: false, error: 'no post id returned' };
    }

    const videos = items.filter(isVideoItem);
    const images = items.filter((m) => !isVideoItem(m));

    if (videos.length > 0) {
      // Single video feed post (FB has no video-carousel feed primitive).
      const r = await metaGraphFetch(`/${pageId}/videos`, {
        accessToken: token,
        method: 'POST',
        body: { file_url: videos[0].url, description: content },
        timeoutMs: 60_000,
      });
      if (!r.ok) return { ok: false, error: `FB video: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
      const id = (r.data as any)?.id;
      return id ? { ok: true, externalPostId: String(id) } : { ok: false, error: 'FB video: no id returned' };
    }

    if (images.length === 1) {
      const r = await metaGraphFetch(`/${pageId}/photos`, {
        accessToken: token,
        method: 'POST',
        body: { url: images[0].url, caption: content },
        timeoutMs: 20_000,
      });
      if (!r.ok) return { ok: false, error: `FB photo: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
      const pid = (r.data as any)?.post_id ?? (r.data as any)?.id;
      return pid ? { ok: true, externalPostId: String(pid) } : { ok: false, error: 'FB photo: no id returned' };
    }

    // Multi-photo feed post: upload each unpublished, then attach to one post.
    const mediaFbids: string[] = [];
    for (const m of images.slice(0, 10)) {
      const up = await metaGraphFetch(`/${pageId}/photos`, {
        accessToken: token,
        method: 'POST',
        body: { url: m.url, published: false },
        timeoutMs: 20_000,
      });
      if (!up.ok) return { ok: false, error: `FB photo upload: ${up.error.message}`.slice(0, 500), isAuthError: up.error.isAuthError };
      const id = (up.data as any)?.id;
      if (id) mediaFbids.push(String(id));
    }
    if (!mediaFbids.length) return { ok: false, error: 'FB multi-photo: no uploads succeeded' };
    const r = await metaGraphFetch(`/${pageId}/feed`, {
      accessToken: token,
      method: 'POST',
      body: { message: content, attached_media: mediaFbids.map((id) => ({ media_fbid: id })) },
      timeoutMs: 20_000,
    });
    if (!r.ok) return { ok: false, error: r.error.message.slice(0, 500), isAuthError: r.error.isAuthError };
    const id = (r.data as any)?.id;
    return id ? { ok: true, externalPostId: String(id) } : { ok: false, error: 'no post id returned' };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Facebook publish error (${pageId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/**
 * Upload one image to LinkedIn for an organic post: initializeUpload (owner =
 * author urn) → download the bytes (SSRF-guarded safeFetch) → PUT them to the
 * returned dms-uploads URL. Returns the `urn:li:image:...` to reference in the
 * post content, or an error.
 */
async function linkedinUploadImage(
  token: string,
  author: string,
  item: MediaItem,
): Promise<{ urn?: string; error?: string; isAuthError?: boolean }> {
  const init = await linkedinRest('/rest/images?action=initializeUpload', {
    accessToken: token,
    method: 'POST',
    body: { initializeUploadRequest: { owner: author } },
  });
  if (!init.ok) {
    return { error: `LinkedIn image init: ${init.error.message}`.slice(0, 500), isAuthError: init.error.isAuthError };
  }
  const value = (init.data as any)?.value;
  const uploadUrl: string = value?.uploadUrl;
  const imageUrn: string = value?.image;
  if (!uploadUrl || !imageUrn) return { error: 'LinkedIn image init: missing uploadUrl/image' };

  const dl = await safeFetch(item.url, { method: 'GET', timeoutMs: 20_000 });
  if (!dl.ok) return { error: `LinkedIn image download failed: ${dl.status}` };
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (bytes.length === 0) return { error: 'LinkedIn image download: empty body' };
  const mime = item.mime || dl.headers.get('content-type') || 'image/jpeg';

  const up = await linkedinUpload(uploadUrl, bytes, mime);
  if (!up.ok) return { error: `LinkedIn image upload failed: ${up.status}` };
  return { urn: imageUrn };
}

/** Publish to LinkedIn via the versioned Posts API (POST /rest/posts). */
async function publishLinkedIn(
  account: AccountRow,
  content: string,
  items: MediaItem[],
  options?: LinkedinPostOptions,
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
  const visibility = options?.visibility ?? 'PUBLIC';

  // Build content from media. Video is handled in task 1.3; here: images only.
  let postContent: Record<string, unknown> | undefined;
  const imageItems = (items || []).filter((m) => !isVideoItem(m));
  if (imageItems.length > 0) {
    const urns: string[] = [];
    for (const item of imageItems) {
      const up = await linkedinUploadImage(token, author, item);
      if (up.error) return { ok: false, error: up.error, isAuthError: up.isAuthError };
      urns.push(up.urn);
    }
    postContent =
      urns.length === 1
        ? { media: { id: urns[0] } }
        : { multiImage: { images: urns.map((id) => ({ id })) } };
  }

  const body: Record<string, unknown> = {
    author,
    commentary: content,
    visibility,
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    ...(postContent ? { content: postContent } : {}),
  };

  const result = await linkedinRest('/rest/posts', { accessToken: token, method: 'POST', body });
  if (!result.ok) {
    logger.warn(`LinkedIn publish failed (${account.externalId}): ${result.error.message}`);
    return { ok: false, error: result.error.message.slice(0, 500), isAuthError: isLinkedinAuthError(result) };
  }
  const id = result.restliId;
  if (!id) return { ok: false, error: 'LinkedIn /rest/posts returned no x-restli-id' };
  return { ok: true, externalPostId: String(id) };
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

/** Dispatch to the correct per-network adapter. `opts.format` (FEED|REEL|STORY)
 *  and per-item MIME are honoured by FB/IG; the other networks ignore them. */
export async function publishToNetwork(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const format = opts.format ?? 'FEED';
  const items = toMediaItems(mediaUrls, opts);
  switch (account.network) {
    case 'FACEBOOK':
      return publishFacebook(account, content, items, format);
    case 'INSTAGRAM':
      return publishInstagram(account, content, items, format);
    case 'LINKEDIN':
      return publishLinkedIn(account, content, items, opts.linkedin);
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
