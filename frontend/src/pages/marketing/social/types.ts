import type { SocialNetwork } from './socialSchemas';

/**
 * Response shapes returned by the backend social-planner controller.
 * Mirrors social-planner.service.ts (accounts have their accessToken MASKED
 * before they ever reach the client).
 */

export type PostStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
export type TargetStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface SocialAccount {
  id: string;
  network: SocialNetwork;
  externalId: string;
  displayName: string;
  /** Already masked by the backend (e.g. "••••abcd") — never raw. */
  accessToken: string;
  tokenExpiresAt: string | null;
  enabled: boolean;
  createdAt: string;
  /** PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK (OAUTH-connected accounts). */
  accountType?: string | null;
  /** MANUAL | OAUTH. */
  connectedVia?: string | null;
  /** Set to 'reauth_required' when a token refresh fails. */
  lastError?: string | null;
}

export interface SocialPostTarget {
  id: string;
  postId: string;
  socialAccountId: string;
  network: SocialNetwork;
  status: TargetStatus;
  externalPostId: string | null;
  error: string | null;
}

/** Per-post publish options stored as JSON on the backend. */
export interface TikTokPostOptions {
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  mediaType?: 'VIDEO' | 'PHOTO';
  coverIndex?: number;
}

export interface PostOptions {
  tiktok?: TikTokPostOptions;
}

export interface SocialPost {
  id: string;
  content: string;
  mediaUrls: string[];
  /** Per-post publish options (e.g. TikTok privacy level, interaction caps). */
  options?: PostOptions | null;
  status: PostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targets: SocialPostTarget[];
}

export interface NetworkStatus {
  FACEBOOK: boolean;
  INSTAGRAM: boolean;
  LINKEDIN: boolean;
  TIKTOK: boolean;
  // Epic 12 (needs-external, inert until creds).
  TWITTER: boolean;
  PINTEREST: boolean;
  GMB: boolean;
  secretBoxConfigured: boolean;
}
