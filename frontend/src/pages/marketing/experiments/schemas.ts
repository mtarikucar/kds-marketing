import { z } from 'zod';

// ── Affiliates ────────────────────────────────────────────────────────────────
// (The A/B-experiment and survey schemas that used to live here died with those
// features — 2026-07 system trim.)

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
