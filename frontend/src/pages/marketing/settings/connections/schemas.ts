import { z } from 'zod';
import { SLACK_EVENTS } from './types';

/**
 * Form schema for the Slack dialog. Mirrors the backend DTO validators
 * (class-validator) so bad input is rejected before the round-trip; the API
 * stays the source of truth.
 *
 * (The SSO dialog carries its own dialog-local schema in SsoFormDialog.tsx
 * because its "allowed domains" textarea is split client-side before submit.)
 */

// Slack incoming webhooks are https://hooks.slack.com/... — accept any https URL
// (backend uses a generic IsUrl) but require https so the secret isn't sent clear.
const slackWebhookUrl = z
  .string()
  .trim()
  .min(1, 'required')
  .max(2000)
  .refine((v) => /^https:\/\//i.test(v), { message: 'httpsRequired' })
  .refine((v) => {
    try {
      // eslint-disable-next-line no-new
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }, { message: 'invalidUrl' });

export const slackCreateSchema = z.object({
  webhookUrl: slackWebhookUrl,
  channel: z.string().trim().max(80).optional(),
  events: z.array(z.enum(SLACK_EVENTS)),
});

export type SlackCreateValues = z.infer<typeof slackCreateSchema>;

// On edit the webhook URL is optional — blank keeps the stored one.
export const slackEditSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .refine((v) => !v || /^https:\/\//i.test(v), { message: 'httpsRequired' }),
  channel: z.string().trim().max(80).optional(),
  events: z.array(z.enum(SLACK_EVENTS)),
});

export type SlackEditValues = z.infer<typeof slackEditSchema>;
