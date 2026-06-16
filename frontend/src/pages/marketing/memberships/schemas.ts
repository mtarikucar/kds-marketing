import { z } from 'zod';

/**
 * Form schemas for the Memberships dialogs. Mirror the backend DTO validators
 * (course.dto.ts / community.dto.ts) so the frontend rejects bad input before
 * the round-trip; the API stays the source of truth.
 */

// ── Courses ───────────────────────────────────────────────────────────────────

export const courseSchema = z.object({
  // CreateCourseDto: title required, MaxLength 160.
  title: z.string().trim().min(1, 'required').max(160),
  description: z.string().trim().max(5000).optional(),
  // Backend stores money in cents; the form takes a major-unit amount.
  price: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), { message: 'priceInvalid' }),
  currency: z.string().trim().max(8).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
});

export type CourseFormValues = z.input<typeof courseSchema>;

export const moduleSchema = z.object({
  title: z.string().trim().min(1, 'required').max(160),
});
export type ModuleFormValues = z.infer<typeof moduleSchema>;

const LESSON_TYPES = ['VIDEO', 'TEXT', 'PDF', 'QUIZ'] as const;

export const lessonSchema = z.object({
  title: z.string().trim().min(1, 'required').max(200),
  type: z.enum(LESSON_TYPES),
  content: z.string().trim().max(100000).optional(),
  videoUrl: z.string().trim().max(2000).optional(),
  durationSec: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), { message: 'durationInvalid' }),
  isPreview: z.boolean().optional(),
});
export type LessonFormValues = z.input<typeof lessonSchema>;

// ── Communities ───────────────────────────────────────────────────────────────

export const communitySchema = z.object({
  name: z.string().trim().min(1, 'required').max(120),
  description: z.string().trim().max(5000).optional(),
});
export type CommunityFormValues = z.infer<typeof communitySchema>;

export const postSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, 'required').max(20000),
});
export type PostFormValues = z.infer<typeof postSchema>;

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'required').max(10000),
});
export type CommentFormValues = z.infer<typeof commentSchema>;
