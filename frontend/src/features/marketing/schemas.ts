import { z } from 'zod';

/**
 * Shared zod schemas for the marketing forms. Mirrors the backend
 * DTO validation so a payload that passes the frontend schema is
 * always payload-shaped for the API. Backend remains the source of
 * truth — these schemas exist to give immediate feedback before the
 * round-trip, not to relax server-side checks.
 */

const HHMM_OR_EMPTY = z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$|^$/);
// E.164-ish: optional +, 8-15 digits. Mirrors the backend PHONE_REGEX.
const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;

const optionalEmail = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'emailInvalid' });

const optionalPhone = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || PHONE_REGEX.test(v), { message: 'phoneInvalid' });

const optionalIntString = z
  .string()
  .optional()
  .refine((v) => !v || /^\d+$/.test(v), { message: 'numberPositive' });

export const leadSchema = z.object({
  businessName: z.string().trim().min(1, 'required').max(200),
  contactPerson: z.string().trim().min(1, 'required').max(120),
  // Workspace-defined taxonomy key (UPPER_SNAKE) — mirrors the backend's
  // BUSINESS_TYPE_PATTERN; the select still offers the default list, but any
  // workspace-configured value round-trips through edits unchanged.
  businessType: z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,59}$/, 'required'),
  source: z.enum(['INSTAGRAM', 'REFERRAL', 'FIELD_VISIT', 'ADS', 'WEBSITE', 'PHONE', 'OTHER']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  phone: optionalPhone,
  whatsapp: optionalPhone,
  email: optionalEmail,
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  tableCount: optionalIntString,
  branchCount: optionalIntString,
  currentSystem: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  nextFollowUp: z.string().optional(),
});

export type LeadFormValues = z.infer<typeof leadSchema>;

export const offerSchema = z
  .object({
    leadId: z.string().min(1, 'required'),
    planId: z.string().optional(),
    customPrice: z
      .number({ invalid_type_error: 'numberPositive' })
      .nonnegative('numberPositive')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    discount: z
      .number({ invalid_type_error: 'numberRange' })
      .min(0, 'numberRange')
      .max(100, 'numberRange')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    trialDays: z
      .number({ invalid_type_error: 'numberPositive' })
      .int()
      .min(0)
      .max(365)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    validUntil: z.string().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine(
    (d) => d.planId || (d.customPrice !== undefined && d.customPrice !== null),
    {
      message: 'planOrPriceRequired',
      path: ['planId'],
    },
  );

export type OfferFormValues = z.infer<typeof offerSchema>;

export const taskSchema = z.object({
  title: z.string().trim().min(1, 'required').max(200),
  description: z.string().trim().max(2000).optional(),
  type: z.enum(['CALL', 'VISIT', 'DEMO', 'FOLLOW_UP', 'MEETING', 'OTHER']).default('FOLLOW_UP'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  dueDate: z
    .string()
    .min(1, 'required')
    .refine((v) => new Date(v).getTime() > Date.now() - 5 * 60 * 1000, { message: 'dateFuture' }),
  leadId: z.string().optional(),
  assignedToId: z.string().optional(),
});

export type TaskFormValues = z.infer<typeof taskSchema>;

export const marketingUserSchema = z
  .object({
    firstName: z.string().trim().min(1, 'required').max(80),
    lastName: z.string().trim().min(1, 'required').max(80),
    email: z
      .string()
      .trim()
      .min(1, 'required')
      .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'emailInvalid' }),
    phone: optionalPhone,
    role: z.enum(['MANAGER', 'REP']),
    password: z.string().optional(),
    passwordConfirm: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // Password rules apply only when one is being set (create flow or
    // explicit password reset). On edit-without-password-change the
    // fields stay empty and we skip the rules.
    if (data.password || data.passwordConfirm) {
      if (!data.password || data.password.length < 8) {
        ctx.addIssue({
          path: ['password'],
          code: z.ZodIssueCode.custom,
          message: 'passwordMin',
        });
      } else if (!/[A-Z]/.test(data.password) || !/[a-z]/.test(data.password) || !/\d/.test(data.password)) {
        ctx.addIssue({
          path: ['password'],
          code: z.ZodIssueCode.custom,
          message: 'passwordWeak',
        });
      }
      if (data.password !== data.passwordConfirm) {
        ctx.addIssue({
          path: ['passwordConfirm'],
          code: z.ZodIssueCode.custom,
          message: 'passwordMismatch',
        });
      }
    }
  });

export type MarketingUserFormValues = z.infer<typeof marketingUserSchema>;

/**
 * Helper: run a zod schema parse and collect error messages keyed by
 * field path. Use this in modal forms (OffersPage, TasksPage) that
 * keep their useState-based form state instead of migrating to RHF —
 * call before mutation.mutate and bail with `setErrors(errors)` if
 * any.
 */
export function collectZodErrors(parsed: z.SafeParseReturnType<unknown, unknown>): Record<string, string> {
  if (parsed.success) return {};
  const result: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.');
    if (!result[key]) result[key] = issue.message;
  }
  return result;
}
