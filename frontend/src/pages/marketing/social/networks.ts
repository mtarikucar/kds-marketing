import { Facebook, Instagram, Linkedin, Music2, Twitter, Image, Store, type LucideIcon } from 'lucide-react';
import type { SocialNetwork } from './socialSchemas';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface NetworkMeta {
  label: string;
  icon: LucideIcon;
  tone: BadgeTone;
}

/** Presentation metadata for each supported social network. */
export const NETWORK_META: Record<SocialNetwork, NetworkMeta> = {
  FACEBOOK: { label: 'Facebook', icon: Facebook, tone: 'info' },
  INSTAGRAM: { label: 'Instagram', icon: Instagram, tone: 'danger' },
  INSTAGRAM_LOGIN: { label: 'Instagram (Login)', icon: Instagram, tone: 'danger' },
  LINKEDIN: { label: 'LinkedIn', icon: Linkedin, tone: 'primary' },
  TIKTOK: { label: 'TikTok', icon: Music2, tone: 'neutral' },
  // Epic 12 (needs-external, inert until creds): X, Pinterest, Google Business.
  TWITTER: { label: 'X (Twitter)', icon: Twitter, tone: 'neutral' },
  PINTEREST: { label: 'Pinterest', icon: Image, tone: 'danger' },
  GMB: { label: 'Google Business', icon: Store, tone: 'success' },
};

export const POST_STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  PUBLISHING: 'warning',
  PUBLISHED: 'success',
  FAILED: 'danger',
};

export const TARGET_STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: 'neutral',
  PUBLISHED: 'success',
  FAILED: 'danger',
};
