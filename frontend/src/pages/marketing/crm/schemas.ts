import { z } from 'zod';

/**
 * Form schemas for the CRM-config dialogs. Mirror the backend DTO validators so
 * the frontend rejects bad input before the round-trip; the API stays the
 * source of truth.
 */

const CF_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'DATETIME',
  'BOOL',
  'SELECT',
  'MULTISELECT',
  'URL',
  'PHONE',
  'EMAIL',
] as const;

const optionRow = z.object({
  value: z.string().trim().min(1, 'required').max(120),
  label: z.string().trim().min(1, 'required').max(120),
});

export const customFieldSchema = z
  .object({
    label: z.string().trim().min(1, 'required').max(80),
    // Optional explicit slug; lower_snake_case. Immutable after create.
    key: z
      .string()
      .trim()
      .max(64)
      .optional()
      .refine((v) => !v || /^[a-z][a-z0-9_]*$/.test(v), { message: 'keySnakeCase' }),
    type: z.enum(CF_TYPES),
    options: z.array(optionRow).optional(),
    required: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.type === 'SELECT' || val.type === 'MULTISELECT') && !(val.options?.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'optionsRequired',
        path: ['options'],
      });
    }
  });

export type CustomFieldFormValues = z.infer<typeof customFieldSchema>;

// Hex colour, e.g. #1f7aec. Backend uses class-validator IsHexColor.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const tagSchema = z.object({
  name: z.string().trim().min(1, 'required').max(60),
  color: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || HEX.test(v), { message: 'colorHex' }),
});

export type TagFormValues = z.infer<typeof tagSchema>;

export const segmentMetaSchema = z.object({
  name: z.string().trim().min(1, 'required').max(120),
  description: z.string().trim().max(500).optional(),
});

export type SegmentMetaValues = z.infer<typeof segmentMetaSchema>;
