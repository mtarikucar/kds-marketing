import { z } from 'zod';

/**
 * Co-located zod schemas + types for the IVR / phone-tree builder. These mirror
 * the backend DTO validation in `backend/src/modules/marketing/ivr/ivr.controller.ts`
 * (CreateMenuDto / UpdateMenuDto / CreateOptionDto) and the IvrService invariants
 * so a payload that passes here is API-shaped. The backend remains the source of
 * truth — these exist to give immediate feedback before the round-trip.
 *
 * Lives in the area dir (not features/marketing/schemas.ts) so this feature is
 * self-contained and wired purely from the returned route/nav metadata.
 */

/** The five things a keypad digit can do (mirrors IVR_ACTIONS on the backend). */
export const IVR_ACTIONS = [
  'SUBMENU',
  'DIAL',
  'VOICEMAIL',
  'HANGUP',
  'AI_RECEPTIONIST',
] as const;
export type IvrAction = (typeof IVR_ACTIONS)[number];

/** Valid DTMF keys: 0-9, * and #. */
export const IVR_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'] as const;

/** E.164 — leading +, country digit 1-9, then up to 14 more. Mirrors backend Matches(). */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// ── Menu ─────────────────────────────────────────────────────────────────────

export const menuSchema = z.object({
  name: z.string().trim().min(1, 'required').max(120),
  greeting: z.string().trim().min(1, 'required').max(4000),
  enabled: z.boolean().default(true),
  isRoot: z.boolean().default(false),
});

export type MenuFormValues = z.infer<typeof menuSchema>;

// ── Option ───────────────────────────────────────────────────────────────────

export const optionSchema = z
  .object({
    digit: z
      .string()
      .regex(/^[0-9*#]$/, 'digitInvalid'),
    label: z.string().trim().min(1, 'required').max(120),
    action: z.enum(IVR_ACTIONS),
    targetMenuId: z.string().max(64).optional().or(z.literal('')),
    dialNumber: z.string().trim().optional().or(z.literal('')),
  })
  // SUBMENU requires a target menu.
  .refine((v) => v.action !== 'SUBMENU' || !!v.targetMenuId, {
    message: 'targetRequired',
    path: ['targetMenuId'],
  })
  // DIAL requires an E.164 number.
  .refine((v) => v.action !== 'DIAL' || (!!v.dialNumber && E164_REGEX.test(v.dialNumber)), {
    message: 'dialInvalid',
    path: ['dialNumber'],
  });

export type OptionFormValues = z.infer<typeof optionSchema>;

// ── API response shapes (from IvrService) ────────────────────────────────────

export interface IvrOption {
  id: string;
  menuId: string;
  digit: string;
  label: string;
  action: IvrAction;
  targetMenuId: string | null;
  dialNumber: string | null;
  createdAt?: string;
}

export interface IvrMenu {
  id: string;
  name: string;
  greeting: string;
  enabled: boolean;
  isRoot: boolean;
  options: IvrOption[];
  createdAt?: string;
  updatedAt?: string;
}

/** Human label for each action (defaultValue fallbacks for i18n). */
export const ACTION_LABELS: Record<IvrAction, string> = {
  SUBMENU: 'Go to submenu',
  DIAL: 'Forward to number',
  VOICEMAIL: 'Take a voicemail',
  HANGUP: 'Hang up',
  AI_RECEPTIONIST: 'AI receptionist',
};
