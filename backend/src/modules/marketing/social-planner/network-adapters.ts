import { Logger } from '@nestjs/common';
import Jimp from 'jimp';
import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import {
  isGoogleOAuthConfigured,
  GOOGLE_CLIENT_ID_ENVS,
  GOOGLE_CLIENT_SECRET_ENVS,
} from '../../../common/util/google-oauth-env';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';
import { linkedinRest, linkedinUpload, isLinkedinAuthError } from '../../../common/util/linkedin-api.util';
import { queryCreatorInfo, validatePrivacyLevel } from './tiktok-creator-info.util';
import { R2StorageService } from '../../../common/storage/r2-storage.service';

export interface TikTokPostOptions {
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  mediaType?: 'VIDEO' | 'PHOTO';
  coverIndex?: number;
}

const logger = new Logger('NetworkAdapters');

export interface PublishResult {
  ok: boolean;
  externalPostId?: string;
  error?: string;
  /** True when the failure is a Meta token problem needing reconnect. */
  isAuthError?: boolean;
  /**
   * Media handed to this adapter that it did NOT send, and why.
   *
   * Every adapter here has a shape its platform accepts — one video, four
   * images, a ten-slide carousel — and every one of them used to reach that
   * shape by INDEXING (`videos[0]`, `mediaUrls[0]`, `.slice(0, 10)`) and saying
   * nothing about the remainder. A five-beat concept generated five clips, was
   * charged for five, published one, and no error, no warning and no row
   * recorded the other four.
   *
   * A platform that accepts one video accepts one video — that is not a defect
   * and this field does not try to publish more. What it fixes is the silence:
   * a drop is now a fact the publish path returns, `publishDuePost` records on
   * the target row, and a human can read afterwards.
   *
   * Most VIDEO overflow no longer reaches here at all: `selectMediaForTarget`
   * trims each target to what its network carries before the adapter is called,
   * and reports that drop itself. What still surfaces through this field is the
   * shape only the adapter knows — images past a carousel's limit, a Facebook
   * video that displaces the images beside it.
   */
  droppedMedia?: { count: number; reason: string };
}

export interface AccountRow {
  id: string;
  network: string;
  externalId: string;
  accessToken: string; // SEALED
  /** PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK — selects the LinkedIn author URN. */
  accountType?: string | null;
}

/**
 * Returns the access token or null if secret-box not configured / malformed.
 *
 * EXPORTED so the read path (network-insights.ts) opens a sealed token through
 * this exact function rather than growing a second copy of the same three
 * lines. There must be one place where a SocialAccount credential is unsealed:
 * if the unsealing rule ever changes (key rotation, a different box format), a
 * second copy is the one that keeps working until it silently does not.
 */
export function revealToken(account: AccountRow): string | null {
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
    case 'INSTAGRAM_LOGIN':
      return !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
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

/**
 * How many VIDEO files ONE post on this network+format can actually carry.
 *
 * This is not a wish list — each number is what the adapter below physically
 * does, read off the code that does it, and the two must be changed together:
 *
 *  - **FACEBOOK** — 1, any format. `/{page}/videos` takes one `file_url`; there
 *    is no video-carousel feed primitive on the Graph API.
 *  - **INSTAGRAM** — FEED 10 (a carousel may hold ten VIDEO children), REEL and
 *    STORY 1. Note that ten videos in a feed carousel is ten swipeable clips,
 *    not one video; it does not throw anything away, which is a lower bar.
 *  - **INSTAGRAM_LOGIN** — 1. The direct Login API publishes a single container.
 *  - **LINKEDIN** — 1. `/rest/posts` content takes a single video `media.id`;
 *    `multiImage` is images only.
 *  - **TIKTOK** — 1. `video/init` takes one `video_url` (its PHOTO mode takes 35
 *    images, which is a different media type).
 *  - **TWITTER** — 0. `uploadXMedia` posts `media_category: tweet_image` with a
 *    5 MB cap: images only, so a video target drops the file entirely.
 *  - **PINTEREST** — 0. A pin's `media_source` is `image_url`.
 *  - **GMB** — 0. A Local Post's media is `mediaFormat: PHOTO`.
 *
 * Exported because it is the SELECTOR, not a veto. `selectMediaForTarget` reads
 * it once per target to decide how much of the post that destination is handed;
 * the content line reads it before a human approves, to say what each
 * destination will actually receive.
 *
 * It used to drive a blanket refusal (`assertDestinationsCanCarry`): a concept
 * had to fit EVERY targeted account or nothing was produced at all. Measured
 * against this very table that refused seven of the eight networks — every
 * concept is at least two beats, and only Instagram's feed carries two — so a
 * vertical-video feature worked on an all-Instagram campaign and nowhere else.
 * The refusal is gone. The same approved concept is a carousel on Instagram and
 * a single hero clip on TikTok, and both are legitimate publishes.
 */
export function maxPublishableVideos(network: string, format: PostFormat = 'FEED'): number {
  switch (network) {
    case 'FACEBOOK':
      return 1;
    case 'INSTAGRAM':
      return format === 'FEED' ? 10 : 1;
    case 'INSTAGRAM_LOGIN':
    case 'LINKEDIN':
    case 'TIKTOK':
      return 1;
    case 'TWITTER':
    case 'PINTEREST':
    case 'GMB':
      return 0;
    default:
      // An unknown network publishes nothing at all (`publishToNetwork` returns
      // "Unknown network"), so promising it any capacity would be a lie.
      return 0;
  }
}

/**
 * Attach "and these N were not sent" to a SUCCESSFUL publish.
 *
 * Only to a successful one: a failed publish sent nothing at all, and its
 * `error` already says so — annotating it with a partial-drop count would
 * describe a post that does not exist. One helper so no adapter has to remember
 * the shape, or — as before — remember to mention the drop at all.
 */
function withDrop(r: PublishResult, sent: number, given: number, reason: string): PublishResult {
  if (!r.ok || given <= sent) return r;
  return { ...r, droppedMedia: { count: given - sent, reason } };
}

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
  /** TikTok-specific privacy/interaction/photo controls. */
  tiktok?: TikTokPostOptions;
  /**
   * THE MEDIA WAS GENERATED FOR THIS POST — it is a campaign item's renders,
   * planned, paid for and approved as the post itself, not a picture somebody
   * attached to words they wrote.
   *
   * Only one adapter reads it, and only where it decides whether a post may go
   * out WITHOUT its media: see `publishTwitter`. Every other adapter fails the
   * publish when an upload fails, so the question never arises there.
   *
   * `publishDuePost` sets it; direct callers leave it unset, which is the safe
   * default (a post nobody generated media for is treated as hand-composed).
   */
  mediaGeneratedForPost?: boolean;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|qt)(?:[?#]|$)/i;
function isVideoItem(item: MediaItem): boolean {
  if (item.mime) return item.mime.toLowerCase().startsWith('video/');
  return VIDEO_EXT.test(item.url);
}
function toMediaItems(mediaUrls: string[], opts: PublishOptions): MediaItem[] {
  return (mediaUrls || []).map((url, i) => ({ url, mime: opts.mediaMime?.[i] }));
}

/** One destination's share of a post's media. See {@link selectMediaForTarget}. */
export interface TargetMediaSelection {
  /** What this destination is handed, in the post's own (beat) order. */
  media: MediaItem[];
  /** What this destination cannot take, and the network limit that says so. */
  dropped: { count: number; reason: string } | null;
  /**
   * The post CARRIES media and this destination can take none of it.
   *
   * A FACT, not a verdict. What it means depends on the post: media GENERATED
   * for a post is the post, so a destination that can take none of it must not
   * be published to at all; an image somebody attached to words they wrote is
   * not, so the words still go out and the loss is recorded on the row. The
   * caller decides which post this is — `SocialPlannerService.publishDuePost`.
   */
  carriesNothing: boolean;
}

/** Every format a target can be set to — the axis a capacity may vary along. */
const ALL_FORMATS: PostFormat[] = ['FEED', 'REEL', 'STORY'];

/**
 * How this network's video limit reads in a sentence a human gets to see.
 *
 * NAMES THE FORMAT WHENEVER THE NUMBER DEPENDS ON IT. Instagram carries ten
 * videos in a feed carousel and one as a Reel or Story, so "INSTAGRAM carries 1
 * video per post" — printed at a target somebody set to REEL — is a true
 * sentence about that target and a false sentence about Instagram, and it reads
 * as the second. The operator who acts on it moves the campaign off Instagram
 * when the fix was to publish the same three clips to the feed.
 *
 * Where the capacity is the same at every format (Facebook's one video, X's
 * none) the format is left out: naming it would imply a choice that does not
 * exist and invite the operator to go hunting for a setting that changes
 * nothing.
 */
function videoCapacityPhrase(network: string, cap: number, format: PostFormat): string {
  const variesByFormat = ALL_FORMATS.some((f) => maxPublishableVideos(network, f) !== cap);
  const subject = variesByFormat ? `${network} ${format}` : network;
  if (cap <= 0) return `${subject} cannot carry video at all`;
  return `${subject} carries ${cap} video${cap === 1 ? '' : 's'} per post`;
}

/**
 * WHAT THIS DESTINATION TAKES — decided per target, never all-or-nothing.
 *
 * A post carries the clips that were made. Each target then takes the first N
 * its network+format can carry, IN THE POST'S OWN ORDER, and what it could not
 * take is returned so the caller can record it on that target's row.
 *
 * Order is load-bearing and is never re-sorted here: `generatedAssetIds` is
 * beat order (hook first, payoff last), the confirm gate sorts the asset rows
 * back into it, and a selection that took "any N" would publish the call to
 * action as the hook. First N, in the order given.
 *
 * Only VIDEO is metered. Images pass through untouched — the adapters each
 * carry their own image shape (four on X, ten in a Facebook carousel, 35 in a
 * TikTok photo post) and report their own overflow through `withDrop`. Two
 * places counting the same limit is how the two answers drift apart; this one
 * answers the question the concept line actually asks, which is about clips.
 */
export function selectMediaForTarget(
  media: MediaItem[],
  network: string,
  format: PostFormat = 'FEED',
): TargetMediaSelection {
  const given = media ?? [];
  const cap = maxPublishableVideos(network, format);
  const kept: MediaItem[] = [];
  let takenVideos = 0;
  let droppedVideos = 0;
  for (const item of given) {
    if (!isVideoItem(item)) {
      kept.push(item);
      continue;
    }
    if (takenVideos < cap) {
      kept.push(item);
      takenVideos++;
    } else {
      droppedVideos++;
    }
  }
  return {
    media: kept,
    dropped: droppedVideos
      ? { count: droppedVideos, reason: videoCapacityPhrase(network, cap, format) }
      : null,
    carriesNothing: given.length > 0 && kept.length === 0,
  };
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

/** Bytes cap for fetching a source image before transcoding (generous; the
 *  re-encoded JPEG is far smaller and Instagram caps the final at 8MB). */
const IG_IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
/** Instagram downscales feed images to 1080px wide regardless — do it ourselves
 *  (controlled, sharper) so the only quality change is one clean resize. */
const IG_JPEG_MAX_WIDTH = 1080;

/**
 * True when an item is an IMAGE that Instagram's API would reject. The Content
 * Publishing API accepts ONLY JPEG — PNG/WebP/GIF image_urls create a container
 * but fail media_publish with "Media ID is not available". Videos are exempt.
 */
export function igImageNeedsJpeg(item: MediaItem): boolean {
  if (isVideoItem(item)) return false;
  const mime = (item.mime ?? '').toLowerCase();
  if (mime) return mime !== 'image/jpeg' && mime !== 'image/jpg';
  // No/unknown mime → trust the URL extension; anything not .jpg/.jpeg is suspect.
  return !/\.jpe?g(?:[?#]|$)/i.test(item.url);
}

/**
 * Prepare an Instagram image item: JPEG, and no wider than Instagram's own
 * display width. Re-hosts the result on R2 so Meta can pull it.
 *
 * Two reasons an item needs work, and it used to only act on the first:
 *
 *  1. NOT JPEG. The Content Publishing API accepts only JPEG; a PNG/WebP
 *     creates a container and then fails `media_publish`. The mobile app
 *     re-encodes silently, the Graph API does not, so we must.
 *  2. TOO WIDE. Instagram downscales feed images to 1080px anyway, and the
 *     resize above was written for exactly that — but it sat behind an early
 *     `if (!igImageNeedsJpeg(item)) return item`, so it only ever ran on images
 *     that were being transcoded for reason 1. An already-JPEG image went to
 *     Meta at whatever size it happened to be.
 *
 * That gap is not cosmetic. Meta fetches `image_url` itself, and a 2048×2048 /
 * ~1MB JPEG handed over unresized came back with its bottom third decoded as
 * flat grey — a truncated fetch, published and unrecoverable (Instagram has no
 * "replace the image" edit). At 1080/q90 the same picture is 4–5× smaller,
 * which is both the documented intent and a far smaller window for a short read.
 *
 * Videos pass through. Any failure — or R2 not configured — returns the
 * original item, so behaviour is never worse than before.
 */
async function ensureIgJpegImage(item: MediaItem, igId: string): Promise<MediaItem> {
  if (isVideoItem(item)) return item;
  const needsJpeg = igImageNeedsJpeg(item);
  const r2 = new R2StorageService();
  if (!r2.isConfigured()) return item;
  try {
    const res = await safeFetch(item.url, { method: 'GET', timeoutMs: 20_000 });
    if (!res.ok) return item;
    const src = await readCappedBytes(res, IG_IMAGE_FETCH_MAX_BYTES);
    if (!src || src.length === 0) return item;
    const img = await Jimp.read(src);
    const srcWidth = img.bitmap.width;
    const tooWide = srcWidth > IG_JPEG_MAX_WIDTH;
    // An already-JPEG image that is already within Instagram's width needs
    // nothing: returning it untouched avoids a pointless re-encode and keeps
    // the original asset URL on the post.
    if (!needsJpeg && !tooWide) return item;
    if (tooWide) img.resize(IG_JPEG_MAX_WIDTH, Jimp.AUTO);
    img.quality(90);
    const jpeg = await img.getBufferAsync(Jimp.MIME_JPEG);
    const up = await r2.upload(igId, { mimetype: 'image/jpeg', buffer: jpeg, size: jpeg.length });
    const why = [needsJpeg ? `${item.mime ?? 'unknown'} → image/jpeg` : null, tooWide ? `${srcWidth}px → ${IG_JPEG_MAX_WIDTH}px` : null]
      .filter(Boolean)
      .join(', ');
    logger.log(`IG image prepared (${why}) for ${igId}`);
    return { url: up.url, mime: 'image/jpeg' };
  } catch (e: any) {
    logger.warn(`IG image prepare failed (${igId}); using original: ${e?.message ?? e}`);
    return item;
  }
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
    // Instagram accepts ONLY JPEG images; transcode any non-JPEG image up front so
    // every container path below (story/feed/carousel) builds with a JPEG image_url.
    items = await Promise.all(items.map((m) => ensureIgJpegImage(m, igId)));

    if (format === 'STORY') {
      const m = items[0];
      const body = isVideoItem(m)
        ? { media_type: 'STORIES', video_url: m.url }
        : { media_type: 'STORIES', image_url: m.url };
      const c = await igCreateContainer(igId, token, body);
      if (!c.id) return { ok: false, error: c.error, isAuthError: c.isAuthError };
      // Poll to FINISHED for images too (not just video) — same race as FEED.
      const w = await igWaitContainerReady(c.id, token);
      if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
      return withDrop(
        await igPublish(igId, token, c.id),
        1,
        items.length,
        'an Instagram story carries one media item',
      );
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
      return withDrop(
        await igPublish(igId, token, c.id),
        1,
        items.length,
        'an Instagram Reel is one video',
      );
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
      // Poll to FINISHED before publishing: Meta needs a moment to fetch/validate
      // the (possibly just-transcoded) image, and publishing too early returns the
      // opaque "Media ID is not available". On a genuinely bad image this surfaces
      // the real status (ERROR/EXPIRED) instead of that generic message.
      const w = await igWaitContainerReady(c.id, token);
      if (!w.ok) return { ok: false, error: w.error, isAuthError: w.isAuthError };
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
    return withDrop(
      await igPublish(igId, token, parent.id),
      children.length,
      items.length,
      'an Instagram carousel holds ten items',
    );
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
/** Photos one Facebook multi-photo feed post attaches. */
const FB_MAX_FEED_PHOTOS = 10;

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
      return withDrop(
        { ok: true, externalPostId: start.videoId },
        1,
        items.length,
        'a Facebook Reel is one video',
      );
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
        return withDrop(
          { ok: true, externalPostId: pid ? String(pid) : start.videoId },
          1,
          items.length,
          'a Facebook story carries one media item',
        );
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
      return withDrop(
        { ok: true, externalPostId: pid ? String(pid) : String(photoId) },
        1,
        items.length,
        'a Facebook story carries one media item',
      );
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
      //
      // ONE of `items` goes out and every other item — the other videos AND any
      // images alongside them — does not. That has always been true; what is new
      // is that the caller is told, instead of four paid renders vanishing with
      // no error, no warning and no record.
      const r = await metaGraphFetch(`/${pageId}/videos`, {
        accessToken: token,
        method: 'POST',
        body: { file_url: videos[0].url, description: content },
        timeoutMs: 60_000,
      });
      if (!r.ok) return { ok: false, error: `FB video: ${r.error.message}`.slice(0, 500), isAuthError: r.error.isAuthError };
      const id = (r.data as any)?.id;
      return id
        ? withDrop(
            { ok: true, externalPostId: String(id) },
            1,
            items.length,
            'a Facebook feed post carries one video and no other media',
          )
        : { ok: false, error: 'FB video: no id returned' };
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
      // NOTHING IS DROPPED HERE, so nothing claims to be. This branch is reached
      // only when `videos.length === 0` and `images.length === 1`, i.e. the post
      // held exactly one item and that one item was sent. The `withDrop` this
      // replaced named a video that cannot be here at all — a video would have
      // returned from the branch above — and `withDrop` would have suppressed
      // the sentence anyway (given === sent), so the only thing it could ever
      // have done was mislead a future reader of this file.
      return pid
        ? { ok: true, externalPostId: String(pid) }
        : { ok: false, error: 'FB photo: no id returned' };
    }

    // Multi-photo feed post: upload each unpublished, then attach to one post.
    const uploaded = images.slice(0, FB_MAX_FEED_PHOTOS);
    const mediaFbids: string[] = [];
    for (const m of uploaded) {
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
    if (!id) return { ok: false, error: 'no post id returned' };
    // WHICH loss this was. Two different things can leave a photo out of this
    // post and they send the reader to two different screens:
    //
    //  - past the tenth photo, Facebook's own per-post shape — nothing to fix; and
    //  - an upload Facebook answered 200 to WITHOUT a photo id, which the loop
    //    above skips silently so the rest of the post still goes out. That one is
    //    a file to go and look at.
    //
    // The sentence this replaced named a third cause that cannot happen here —
    // "and no video" — because a post with any video returned from the branch
    // above; and it printed the ten-photo limit over an id-less upload, so
    // "1 of 4 … holds ten photos" was shown to an operator whose post was four
    // photos long and had hit no limit at all.
    const overflow = images.length - uploaded.length;
    const idless = uploaded.length - mediaFbids.length;
    const why: string[] = [];
    if (idless > 0) {
      why.push(
        `Facebook accepted ${idless === 1 ? 'an upload' : `${idless} uploads`} without returning a photo id`,
      );
    }
    if (overflow > 0) why.push(`a Facebook multi-photo feed post holds ${FB_MAX_FEED_PHOTOS} photos`);
    return withDrop(
      { ok: true, externalPostId: String(id) },
      mediaFbids.length,
      items.length,
      why.join('; '),
    );
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

/**
 * Register-upload a single video for an organic post: initializeUpload (owner =
 * author urn, fileSizeBytes) → PUT each part to its uploadInstructions URL,
 * collecting the per-part ETag → finalizeUpload with the ordered ETags. Returns
 * the `urn:li:video:...` to reference, or an error.
 */
async function linkedinUploadVideo(
  token: string,
  author: string,
  item: MediaItem,
): Promise<{ urn?: string; error?: string; isAuthError?: boolean }> {
  const dl = await safeFetch(item.url, { method: 'GET', timeoutMs: 30_000 });
  if (!dl.ok) return { error: `LinkedIn video download failed: ${dl.status}` };
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (bytes.length === 0) return { error: 'LinkedIn video download: empty body' };
  const mime = item.mime || dl.headers.get('content-type') || 'video/mp4';

  const init = await linkedinRest('/rest/videos?action=initializeUpload', {
    accessToken: token,
    method: 'POST',
    body: { initializeUploadRequest: { owner: author, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } },
  });
  if (!init.ok) {
    return { error: `LinkedIn video init: ${init.error.message}`.slice(0, 500), isAuthError: init.error.isAuthError };
  }
  const value = (init.data as any)?.value;
  const videoUrn: string = value?.video;
  const instructions: { uploadUrl: string; firstByte: number; lastByte: number }[] = value?.uploadInstructions ?? [];
  if (!videoUrn || instructions.length === 0) return { error: 'LinkedIn video init: missing video/uploadInstructions' };

  const uploadedPartIds: string[] = [];
  for (const part of instructions) {
    const slice = bytes.subarray(part.firstByte, part.lastByte + 1);
    const up = await linkedinUpload(part.uploadUrl, slice, mime);
    if (!up.ok) return { error: `LinkedIn video part upload failed: ${up.status}` };
    if (!up.etag) return { error: 'LinkedIn video part upload: missing ETag' };
    uploadedPartIds.push(up.etag);
  }

  const fin = await linkedinRest('/rest/videos?action=finalizeUpload', {
    accessToken: token,
    method: 'POST',
    body: { finalizeUploadRequest: { video: videoUrn, uploadToken: '', uploadedPartIds } },
  });
  if (!fin.ok) {
    return { error: `LinkedIn video finalize: ${fin.error.message}`.slice(0, 500), isAuthError: fin.error.isAuthError };
  }
  return { urn: videoUrn };
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
  try {
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };

  const author =
    account.accountType === 'LI_ORG'
      ? `urn:li:organization:${account.externalId}`
      : `urn:li:person:${account.externalId}`;
  const visibility = options?.visibility ?? 'PUBLIC';

  // Build content from media. A single video takes precedence; otherwise images.
  let postContent: Record<string, unknown> | undefined;
  const videoItem = (items || []).find(isVideoItem);
  const imageItems = (items || []).filter((m) => !isVideoItem(m));
  if (videoItem) {
    const up = await linkedinUploadVideo(token, author, videoItem);
    if (up.error) return { ok: false, error: up.error, isAuthError: up.isAuthError };
    postContent = { media: { id: up.urn } };
  } else if (imageItems.length > 0) {
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
  // `/rest/posts` content is EITHER one video urn OR a multiImage list, so a
  // post that carried a video sent exactly that video and nothing else — and a
  // post with no video sent every item it was given, `multiImage` holding all of
  // them. That is the whole space: THE ONLY LOSS LINKEDIN CAN HAVE HERE is the
  // items a video crowded out (an image whose upload fails returns ok:false
  // above and sends nothing at all, which `withDrop` correctly leaves alone).
  //
  // The no-video sentence this replaced — "carries images or one video, not
  // both" — could never be printed: with no video, `sent === given` and
  // `withDrop` returns the result untouched. It described a mixed post that had
  // already gone down the video branch.
  const sent = videoItem ? 1 : imageItems.length;
  return withDrop(
    { ok: true, externalPostId: String(id) },
    sent,
    (items || []).length,
    'a LinkedIn post carries one video and no other media',
  );
  } catch (e: any) {
    // Media download/upload helpers call safeFetch, which THROWS on SSRF-block, DNS
    // failure, ECONNRESET or timeout. Match every sibling adapter: never let a throw
    // escape into publishDuePost (which would strand the post in PUBLISHING).
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

    // What TikTok was actually handed. A PHOTO post pulls up to 35 images; a
    // VIDEO post pulls exactly one `video_url` — so a five-clip concept sent
    // here published one clip and threw four paid renders away without a word.
    // It still publishes one (TikTok accepts one video); it no longer does so
    // silently.
    const sent = isPhoto ? Math.min(mediaUrls.length, 35) : 1;
    const dropReason = isPhoto
      ? 'a TikTok photo post carries 35 images'
      : 'a TikTok video post carries one video';

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
      if (status === 'PUBLISH_COMPLETE') {
        return withDrop({ ok: true, externalPostId: String(publishId) }, sent, mediaUrls.length, dropReason);
      }
      if (status === 'FAILED') {
        const reason = String(statusJson?.data?.fail_reason ?? 'TikTok rejected the media');
        return { ok: false, error: reason.slice(0, 500) };
      }
    }
    // Still processing after the bounded wait — treat as accepted (queued).
    return withDrop({ ok: true, externalPostId: String(publishId) }, sent, mediaUrls.length, dropReason);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`TikTok publish error (${account.externalId}): ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

// ─────────────────────────────────────── Instagram (direct Instagram Login)

/** Host for the direct "Instagram API with Instagram Login" flow — distinct
 *  from graph.facebook.com (the Page-linked IG_BUSINESS path). Exported for the
 *  read path, which has to make the same host distinction for the same reason:
 *  this flavour uses its own app credentials and carries no appsecret_proof, so
 *  it cannot go through metaGraphFetch. */
export const IG_DIRECT_GRAPH = 'https://graph.instagram.com';

/**
 * Publish to a direct-login Instagram account (graph.instagram.com): create a
 * media container, poll to FINISHED for video, then media_publish. Mirrors the
 * Page-based IG flow but uses the Instagram-hosted Graph and the per-account
 * token directly (no Page token). image_url/video_url must be public HTTPS.
 * Decides image vs video by URL extension / MIME.
 */
async function publishInstagramDirect(
  account: AccountRow,
  content: string,
  items: MediaItem[],
): Promise<PublishResult> {
  if (!isNetworkConfigured('INSTAGRAM_LOGIN')) {
    return { ok: false, error: 'Instagram (Login) not configured: set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  const igId = account.externalId;
  if (items.length === 0) return { ok: false, error: 'Instagram requires at least one media item' };

  const m = items[0];
  const isVideo = isVideoItem(m);

  try {
    // Step 1 — create the media container.
    const createBody = isVideo
      ? { media_type: 'REELS', video_url: m.url, caption: content }
      : { image_url: m.url, caption: content };
    const createRes = await safeFetch(`${IG_DIRECT_GRAPH}/${igId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
      timeoutMs: 20_000,
    });
    const createJson = (await createRes.json()) as Record<string, any>;
    const creationId = createJson?.id;
    if (!createRes.ok || !creationId) {
      const err = String(createJson?.error?.message ?? createRes.status);
      logger.warn(`Instagram (Login) container failed (${igId}): ${err}`);
      return { ok: false, error: `IG container: ${err}`.slice(0, 500) };
    }

    // Step 2 — videos process asynchronously; poll to FINISHED (bounded ≤10s).
    if (isVideo) {
      let finished = false;
      for (let i = 0; i < 5; i++) {
        await sleep(2_000);
        const statusRes = await safeFetch(
          `${IG_DIRECT_GRAPH}/${creationId}?` +
            new URLSearchParams({ fields: 'status_code', access_token: token }).toString(),
          { method: 'GET', timeoutMs: 15_000 },
        );
        const statusJson = (await statusRes.json()) as Record<string, any>;
        const code = statusJson?.status_code;
        if (code === 'FINISHED') {
          finished = true;
          break;
        }
        if (code === 'ERROR' || code === 'EXPIRED') {
          return { ok: false, error: `IG processing ${code}`.slice(0, 300) };
        }
      }
      if (!finished) return { ok: false, error: 'IG media processing timed out' };
    }

    // Step 3 — publish the finished container.
    const pubRes = await safeFetch(`${IG_DIRECT_GRAPH}/${igId}/media_publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: String(creationId) }),
      timeoutMs: 20_000,
    });
    const pubJson = (await pubRes.json()) as Record<string, any>;
    const postId = pubJson?.id;
    if (!pubRes.ok || !postId) {
      const err = String(pubJson?.error?.message ?? pubRes.status);
      logger.warn(`Instagram (Login) publish failed (${igId}): ${err}`);
      return { ok: false, error: `IG publish: ${err}`.slice(0, 500) };
    }
    return withDrop(
      { ok: true, externalPostId: String(postId) },
      1,
      items.length,
      'the Instagram Login API publishes one media container per post',
    );
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram (Login) publish error (${igId}): ${msg}`);
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
 * the size, and posts multipart/form-data. Returns null on any failure; what
 * the caller does with a null depends on WHOSE post it is — see
 * `publishTwitter`.
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

/**
 * Publish to X/Twitter (API v2 POST /2/tweets), with image media. Inert without
 * a paid X app.
 *
 * WHAT HAPPENS WHEN X REFUSES EVERY UPLOAD DEPENDS ON WHOSE POST IT IS, and
 * that is the whole of `mediaGeneratedForPost`:
 *
 *  - a HAND-COMPOSED post is words somebody wrote with an image attached. If the
 *    image flakes, sending the words is the better failure — the tweet goes out
 *    text-only and the row says an upload was refused. Unchanged, deliberately:
 *    this is the older of the two rules and it is right about this post.
 *  - a post whose media was GENERATED FOR IT is the media. Its caption alone is
 *    not a smaller version of it, it is a different post the reviewer never
 *    approved — published on their behalf while the renders they paid for sit
 *    unused. That one FAILS here instead, and `unschedulePost` can put it back
 *    once somebody has looked at the files.
 *
 * The same split, decided from the same flag, guards the pre-flight case in
 * `SocialPlannerService.publishDuePost` (a post whose media this network cannot
 * carry AT ALL). Between them the invariant is whole: a generated post never
 * reaches a timeline as a bare caption, by either route.
 */
async function publishTwitter(
  account: AccountRow,
  content: string,
  mediaUrls: string[],
  mediaGeneratedForPost = false,
): Promise<PublishResult> {
  if (!isNetworkConfigured('TWITTER')) {
    return { ok: false, error: 'X/Twitter not configured: set X_CLIENT_ID and X_CLIENT_SECRET' };
  }
  const token = revealToken(account);
  if (!token) return { ok: false, error: 'accessToken could not be decrypted' };
  try {
    // Upload up to 4 images first (best-effort). A media failure degrades to a
    // text-only tweet rather than dropping the whole post — see the doc block
    // for the one post that is not true of.
    const mediaIds: string[] = [];
    for (const url of mediaUrls.slice(0, X_MAX_MEDIA)) {
      const id = await uploadXMedia(token, url);
      if (id) mediaIds.push(id);
    }
    // A post MADE OF generated media that would go out carrying none of it is
    // not this post. Refused before /2/tweets, so nothing is published and
    // nothing has to be deleted afterwards. A PARTIAL upload still publishes:
    // some of the approved media is on the timeline and `withDrop` below names
    // what is missing.
    if (mediaGeneratedForPost && mediaUrls.length > 0 && mediaIds.length === 0) {
      return {
        ok: false,
        error:
          `not published: X refused all ${mediaUrls.length} generated media file(s), and this post's ` +
          `media was generated for it — publishing would have put the caption out alone, which is not ` +
          `the post that was approved. Check the files, then reschedule.`,
      };
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
    if (res.ok && id) {
      // WHICH loss this was. A drop here has TWO possible causes and they need
      // different actions from whoever reads the row, so one fixed sentence
      // cannot serve both:
      //
      //  - past the fourth file, X's own per-post shape — nothing to fix; and
      //  - a file X (or its host) refused, which `uploadXMedia` swallows to a
      //    null so the tweet still goes out. That one is a file to go and look
      //    at, and the operator is only told to look if the row says so.
      //
      // The sentence this replaced named a third cause that CANNOT happen here:
      // `selectMediaForTarget` gives X a video capacity of zero, so no video
      // ever reaches this adapter, and "and no video" was printed over an image
      // whose upload had simply failed.
      const attempted = Math.min(mediaUrls.length, X_MAX_MEDIA);
      const refused = attempted - mediaIds.length;
      const overflow = mediaUrls.length - attempted;
      const why: string[] = [];
      if (refused > 0) {
        why.push(`X refused ${refused === 1 ? 'the upload' : `${refused} of the uploads`}`);
      }
      if (overflow > 0) why.push('X carries four images per post');
      return withDrop(
        { ok: true, externalPostId: String(id) },
        mediaIds.length,
        mediaUrls.length,
        why.join('; '),
      );
    }
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
    if (res.ok && json?.id) {
      return withDrop(
        { ok: true, externalPostId: String(json.id) },
        1,
        mediaUrls.length,
        'a Pinterest pin is one image',
      );
    }
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
    // Name every spelling the gate accepts. Naming only the bare pair sent an
    // operator who had already set the OAUTH-prefixed one (what deploy.yml
    // ships) looking for a variable that was never the problem.
    return {
      ok: false,
      error:
        'Google Business Profile not configured: set ' +
        `${GOOGLE_CLIENT_ID_ENVS[0]} and ${GOOGLE_CLIENT_SECRET_ENVS[0]}` +
        ` (or the legacy ${GOOGLE_CLIENT_ID_ENVS[1]} / ${GOOGLE_CLIENT_SECRET_ENVS[1]})`,
    };
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
    if (res.ok && json?.name) {
      return withDrop(
        { ok: true, externalPostId: String(json.name) },
        1,
        mediaUrls.length,
        'a Google Business local post carries one photo',
      );
    }
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
    case 'INSTAGRAM_LOGIN':
      return publishInstagramDirect(account, content, items);
    case 'LINKEDIN':
      return publishLinkedIn(account, content, items, opts.linkedin);
    case 'TIKTOK':
      return publishTikTok(account, content, mediaUrls, opts.tiktok);
    case 'TWITTER':
      return publishTwitter(account, content, mediaUrls, opts.mediaGeneratedForPost === true);
    case 'PINTEREST':
      return publishPinterest(account, content, mediaUrls);
    case 'GMB':
      return publishGmb(account, content, mediaUrls);
    default:
      return { ok: false, error: `Unknown network: ${account.network}` };
  }
}
