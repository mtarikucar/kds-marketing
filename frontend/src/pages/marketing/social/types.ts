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

export interface SocialPost {
  id: string;
  content: string;
  mediaUrls: string[];
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
  secretBoxConfigured: boolean;
}
