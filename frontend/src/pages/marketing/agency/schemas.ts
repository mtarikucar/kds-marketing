import { z } from 'zod';

/**
 * Form schemas for the Agency console dialogs. Mirror the backend DTO validators
 * (agency.controller.ts / snapshot.controller.ts / rebilling.controller.ts) so the
 * frontend rejects bad input before the round-trip; the API stays the source of truth.
 */

// ── Create location (CreateLocationDto) ───────────────────────────────────────

export const createLocationSchema = z.object({
  name: z.string().trim().min(1, 'required').max(120),
  productName: z.string().trim().min(1, 'required').max(120),
  productUrl: z.string().trim().max(2048).optional(),
  productDescription: z.string().trim().max(2000).optional(),
  language: z.string().trim().max(8).optional(),
  currency: z.string().trim().max(8).optional(),
  timezone: z.string().trim().max(64).optional(),
  ownerEmail: z.string().trim().min(1, 'required').email('emailInvalid').max(255),
  ownerPassword: z.string().min(8, 'passwordMin').max(128),
  ownerFirstName: z.string().trim().min(1, 'required').max(80),
  ownerLastName: z.string().trim().min(1, 'required').max(80),
});
export type CreateLocationFormValues = z.infer<typeof createLocationSchema>;

// ── Capture snapshot (CreateSnapshotDto) ──────────────────────────────────────

export const captureSnapshotSchema = z.object({
  name: z.string().trim().min(1, 'required').max(120),
  description: z.string().trim().max(2000).optional(),
  // Empty = the agency workspace itself; otherwise a child location id.
  sourceWorkspaceId: z.string().trim().max(64).optional(),
});
export type CaptureSnapshotFormValues = z.infer<typeof captureSnapshotSchema>;

// ── Rebilling plan (UpsertPlanDto — money as numeric strings) ──────────────────

const moneyString = z
  .string()
  .trim()
  .min(1, 'required')
  .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0, { message: 'numberInvalid' });

export const rebillingPlanSchema = z.object({
  basePrice: moneyString,
  usageUnitPrice: moneyString,
  markupPercent: moneyString,
  enabled: z.boolean(),
});
export type RebillingPlanFormValues = z.infer<typeof rebillingPlanSchema>;

// ── Compute charge (ComputeChargeDto — ISO-8601 period) ───────────────────────

export const computeChargeSchema = z
  .object({
    periodStart: z.string().min(1, 'required'),
    periodEnd: z.string().min(1, 'required'),
  })
  .refine((v) => !v.periodStart || !v.periodEnd || new Date(v.periodEnd) > new Date(v.periodStart), {
    message: 'periodOrder',
    path: ['periodEnd'],
  });
export type ComputeChargeFormValues = z.infer<typeof computeChargeSchema>;
