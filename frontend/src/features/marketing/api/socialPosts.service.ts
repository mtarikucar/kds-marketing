/**
 * socialPosts.service.ts — typed client for the social planner's posts and
 * accounts.
 *
 * These calls existed already, inline in `SocialPlannerPage`, as bare
 * `marketingApi.get('/social-planner/posts')` with a cast at the call site. That
 * was survivable while exactly one page made them; the Growth Studio's
 * publishing rail is the second caller, and two call sites casting the same
 * response independently is how the shapes drift apart. Extracted verbatim —
 * same paths, same payload keys, same query keys — so the planner and the rail
 * are guaranteed to be talking about the same rows.
 *
 * Query keys are re-exported here rather than typed out at each call site for
 * the same reason: a near-miss key does not fail, it silently doubles the
 * request and lets two panels disagree about what is scheduled.
 */
import marketingApi from './marketingApi';
import type {
  SocialAccount,
  SocialPost,
  PostStatus,
} from '../../../pages/marketing/social/types';

export type { SocialAccount, SocialPost, PostStatus };

/** The query keys the planner already uses. Reuse, never re-spell. */
export const socialQueryKeys = {
  accounts: ['marketing', 'social', 'accounts'] as const,
  posts: ['marketing', 'social', 'posts'] as const,
  /** Filtered post list — a DIFFERENT cache entry from the unfiltered one. */
  postsIn: (from: string, to: string) => ['marketing', 'social', 'posts', from, to] as const,
};

export interface ListPostsQuery {
  /** ISO instant. Filters on `scheduledAt`, inclusive. */
  from?: string;
  /** ISO instant. Filters on `scheduledAt`, inclusive. */
  to?: string;
  status?: PostStatus;
  /** 1–200. The backend caps the unfiltered list too, but say what you want. */
  limit?: number;
}

/**
 * Posts, optionally windowed by `scheduledAt`.
 *
 * With no arguments this is the planner's original call and returns the whole
 * table newest-first. With `from`/`to` the backend orders by `scheduledAt`
 * ascending instead, which is the order a publishing queue is read in.
 *
 * Pass ISO INSTANTS, never `YYYY-MM-DD`: the backend parses with `new Date()`,
 * so a bare date is read as UTC midnight and the window silently shifts by the
 * workspace's offset. See `pages/marketing/studio/todayBounds.ts`.
 */
export const listSocialPosts = (q: ListPostsQuery = {}) =>
  marketingApi
    .get<SocialPost[]>('/social-planner/posts', { params: q })
    .then((r) => (Array.isArray(r.data) ? r.data : []));

export const listSocialAccounts = () =>
  marketingApi
    .get<SocialAccount[]>('/social-planner/accounts')
    .then((r) => (Array.isArray(r.data) ? r.data : []));

export interface CreatePostPayload {
  content: string;
  media?: { url: string; key?: string; mime?: string }[];
  formats?: Record<string, 'FEED' | 'REEL' | 'STORY'>;
  targetAccountIds?: string[];
  options?: Record<string, unknown>;
}

export const createSocialPost = (payload: CreatePostPayload) =>
  marketingApi.post<SocialPost>('/social-planner/posts', payload).then((r) => r.data);

/** DRAFT posts only — the backend 400s on anything else (`assertDraftPost`). */
export const updateSocialPost = (postId: string, payload: Partial<CreatePostPayload>) =>
  marketingApi.patch<SocialPost>(`/social-planner/posts/${postId}`, payload).then((r) => r.data);

export interface SchedulePayload {
  /** ISO instant. */
  scheduledAt: string;
  targetAccountIds?: string[];
  formats?: Record<string, 'FEED' | 'REEL' | 'STORY'>;
}

/**
 * Schedule — and also RE-schedule: the publish job is deduped on
 * `social-post-<id>`, so calling this on an already-SCHEDULED post moves the
 * existing pending job rather than queueing a second one. There is no separate
 * reschedule endpoint and none is needed.
 */
export const scheduleSocialPost = (postId: string, payload: SchedulePayload) =>
  marketingApi
    .post<SocialPost>(`/social-planner/posts/${postId}/schedule`, payload)
    .then((r) => r.data);

/**
 * Pull a post back to DRAFT.
 *
 * The endpoint has existed since the planner shipped and had, until this screen,
 * no caller at all — which is why "edit something you already scheduled" was not
 * a thing the product could do: `PATCH` refuses anything but a DRAFT. The rail's
 * edit flow is this, then the patch, then a fresh schedule.
 */
export const unscheduleSocialPost = (postId: string) =>
  marketingApi.post<SocialPost>(`/social-planner/posts/${postId}/unschedule`).then((r) => r.data);

/**
 * Publish immediately.
 *
 * FULLY SYNCHRONOUS on the backend: the request is held open while every target
 * is uploaded for real (Meta container polling, TikTok chunked upload, X media),
 * so a multi-target video can take minutes. Never fire this optimistically, and
 * always tell the operator it may take a while.
 */
export const publishSocialPostNow = (postId: string) =>
  marketingApi.post<SocialPost>(`/social-planner/posts/${postId}/publish-now`).then((r) => r.data);

/** Hard delete — targets cascade, there is no soft-delete and no undo. */
export const deleteSocialPost = (postId: string) =>
  marketingApi.delete<void>(`/social-planner/posts/${postId}`).then((r) => r.data);

// ── derived helpers the rail and the planner both need ───────────────────────

/**
 * Did any network fail for this post?
 *
 * `post.status` cannot answer that. `publishDuePost` sets the post to PUBLISHED
 * when AT LEAST ONE target succeeded, so a three-network post where two failed
 * still reads PUBLISHED with a `publishedAt` — the failure is only visible on the
 * targets. Any UI that badges a row from `post.status` alone is quietly lying
 * about a half-published post, which is the failure people most need to see.
 */
export const hasFailedTarget = (post: Pick<SocialPost, 'targets'>) =>
  (post.targets ?? []).some((t) => t.status === 'FAILED');

/** Networks this post actually goes out on, de-duplicated, in target order. */
export const postNetworks = (post: Pick<SocialPost, 'targets'>) =>
  Array.from(new Set((post.targets ?? []).map((t) => t.network)));

/**
 * The first usable image for a thumbnail, or null.
 *
 * `mediaUrls` is NOT cleaned up when the media is purged: R2 drops the file
 * about a week after publish and stamps `options.mediaDeletedAt`, leaving the
 * URLs behind pointing at nothing. Reading the flag here means one place decides
 * "there is no thumbnail" instead of every row shipping a broken image.
 */
export const postThumbnail = (post: Pick<SocialPost, 'mediaUrls' | 'options'>): string | null => {
  if (post.options?.mediaDeletedAt) return null;
  const fromOptions = post.options?.media?.find((m) => m?.url)?.url;
  return fromOptions ?? post.mediaUrls?.[0] ?? null;
};
