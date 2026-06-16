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

export const SOCIAL_NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

// A single http(s) URL — matches the backend @IsUrl() per-item validation.
const httpUrl = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\/.+/i.test(v), { message: 'urlInvalid' });

// ── Post composer ───────────────────────────────────────────────────────────

export const postSchema = z.object({
  // content: required, max 5000 (mirrors @MaxLength(5000))
  content: z.string().trim().min(1, { message: 'required' }).max(5000, { message: 'tooLong' }),
  // mediaUrls: up to 10 http(s) urls (mirrors @IsUrl + @ArrayMaxSize(10))
  mediaUrls: z.array(httpUrl).max(10, { message: 'tooMany' }),
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
