import { z } from 'zod';

/**
 * Local zod schemas for the social planner forms. These mirror the backend
 * social-planner controller DTOs (CreatePostDto / ConnectAccountDto) so a
 * payload that passes here is already shaped for the API. The backend remains
 * the source of truth — these exist for immediate, pre-round-trip feedback.
 *
 * Kept co-located (rather than in the shared schemas.ts) so this area owns its
 * own validation surface.
 */

export const SOCIAL_NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'INSTAGRAM_LOGIN', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GMB'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

// A single http(s) URL — matches the backend @IsUrl() per-item validation.
const httpUrl = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\/.+/i.test(v), { message: 'urlInvalid' });

// ── Post composer ───────────────────────────────────────────────────────────

export const POST_FORMATS = ['FEED', 'REEL', 'STORY'] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

// A media item — either uploaded (carries an R2 `key`) or a pasted URL.
const mediaItem = z.object({
  url: httpUrl,
  key: z.string().optional(),
  mime: z.string().optional(),
});
export type MediaItemValue = z.infer<typeof mediaItem>;

export const postSchema = z.object({
  // content: required, max 5000 (mirrors @MaxLength(5000))
  content: z.string().trim().min(1, { message: 'required' }).max(5000, { message: 'tooLong' }),
  // media: up to 10 items (mirrors @ArrayMaxSize(10))
  media: z.array(mediaItem).max(10, { message: 'tooMany' }),
  // per-account format: { [socialAccountId]: FEED|REEL|STORY } (FB/IG only)
  formats: z.record(z.string(), z.enum(POST_FORMATS)).default({}),
  // target accounts: up to 20 (mirrors @ArrayMaxSize(20))
  targetAccountIds: z.array(z.string()).max(20, { message: 'tooMany' }),
  // optional schedule datetime (local datetime-local string). Empty → publish later.
  scheduledAt: z.string().optional(),
});

export type PostFormValues = z.infer<typeof postSchema>;

// ── Connect account ─────────────────────────────────────────────────────────

export const connectAccountSchema = z.object({
  network: z.enum(SOCIAL_NETWORKS),
  externalId: z.string().trim().min(1, { message: 'required' }).max(200, { message: 'tooLong' }),
  displayName: z.string().trim().min(1, { message: 'required' }).max(200, { message: 'tooLong' }),
  accessToken: z.string().trim().min(1, { message: 'required' }).max(2000, { message: 'tooLong' }),
});

export type ConnectAccountFormValues = z.infer<typeof connectAccountSchema>;
