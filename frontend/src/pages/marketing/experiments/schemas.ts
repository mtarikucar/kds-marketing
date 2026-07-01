import { z } from 'zod';

// ── A/B experiments ───────────────────────────────────────────────────────────

export const variantSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'required')
    .max(40, 'tooLong')
    .regex(/^[a-zA-Z0-9_-]+$/, 'variantKeyFormat'),
  label: z.string().trim().max(80, 'tooLong').optional().or(z.literal('')),
  weight: z.coerce.number().int('integer').min(1, 'min1').max(1000, 'tooBig'),
});

export const experimentSchema = z.object({
  name: z.string().trim().min(1, 'required').max(160, 'tooLong'),
  pageId: z.string().trim().max(120, 'tooLong').optional().or(z.literal('')),
  variants: z
    .array(variantSchema)
    .min(2, 'minVariants')
    .superRefine((variants, ctx) => {
      const seen = new Set<string>();
      variants.forEach((v, i) => {
        const k = v.key.trim().toLowerCase();
        if (seen.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'duplicateKey',
            path: [i, 'key'],
          });
        }
        seen.add(k);
      });
    }),
});

export type ExperimentFormValues = z.infer<typeof experimentSchema>;

// ── Surveys ───────────────────────────────────────────────────────────────────

export const SURVEY_QUESTION_TYPES = [
  'TEXT',
  'TEXTAREA',
  'SINGLE',
  'MULTIPLE',
  'RATING',
] as const;

export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

export const surveyQuestionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, 'required')
      .max(40, 'tooLong')
      .regex(/^[a-zA-Z0-9_-]+$/, 'questionKeyFormat'),
    label: z.string().trim().min(1, 'required').max(200, 'tooLong'),
    type: z.enum(SURVEY_QUESTION_TYPES),
    required: z.boolean(),
    // Comma-separated in the form; serialized to string[] on submit.
    options: z.string().trim().max(500, 'tooLong').optional().or(z.literal('')),
  })
  .superRefine((q, ctx) => {
    if ((q.type === 'SINGLE' || q.type === 'MULTIPLE') && !q.options?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'optionsRequired',
        path: ['options'],
      });
    }
  });

export const surveySchema = z.object({
  name: z.string().trim().min(1, 'required').max(160, 'tooLong'),
  redirectUrl: z.string().trim().max(2000, 'tooLong').optional().or(z.literal('')),
  questions: z
    .array(surveyQuestionSchema)
    .min(1, 'minQuestions')
    // Answers are stored as a map keyed by question.key, so duplicate keys
    // collide — one respondent answer overwrites the other (lost data). The
    // builder's default `q${n}` key can repeat after an add-delete-add. Mirror
    // experimentSchema's variant-key guard.
    .superRefine((questions, ctx) => {
      const seen = new Set<string>();
      questions.forEach((q, i) => {
        const k = q.key.trim().toLowerCase();
        if (seen.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'duplicateKey',
            path: [i, 'key'],
          });
        }
        seen.add(k);
      });
    }),
});

export type SurveyFormValues = z.infer<typeof surveySchema>;

// ── Affiliates ────────────────────────────────────────────────────────────────

export const affiliateSchema = z
  .object({
    name: z.string().trim().min(1, 'required').max(160, 'tooLong'),
    email: z.string().trim().min(1, 'required').email('email'),
    code: z
      .string()
      .trim()
      .min(1, 'required')
      .max(32, 'tooLong')
      .regex(/^[a-zA-Z0-9_-]+$/, 'codeFormat'),
    commissionType: z.enum(['PERCENT', 'FLAT']),
    commissionValue: z.coerce.number().min(0, 'min0').max(1_000_000, 'tooBig'),
    status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']).optional(),
  })
  // Mirror the backend assertCommissionInRange: a PERCENT commission can't exceed
  // 100% (a >100% payout is nonsensical). Without this the form submitted e.g. 150
  // and onError showed an OPAQUE "Failed to create affiliate" toast (the server
  // message is dropped). FLAT is a currency amount, so it stays unbounded.
  .superRefine((val, ctx) => {
    if (val.commissionType === 'PERCENT' && val.commissionValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commissionValue'], message: 'percentMax' });
    }
  });

export type AffiliateFormValues = z.infer<typeof affiliateSchema>;
