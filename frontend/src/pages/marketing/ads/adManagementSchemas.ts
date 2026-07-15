import { z } from 'zod';
import type {
  RuleMetric,
  RuleOperator,
  RuleAction,
} from '../../../features/marketing/api/ads.service';

// ── Campaign objectives (create) ─────────────────────────────────────────────

export const CAMPAIGN_OBJECTIVES = [
  'OUTCOME_LEADS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_SALES',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_AWARENESS',
  'OUTCOME_APP_PROMOTION',
] as const;

export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

/** Friendly fallback labels (used as i18n defaultValue). */
export const OBJECTIVE_LABEL: Record<CampaignObjective, string> = {
  OUTCOME_LEADS: 'Leads',
  OUTCOME_TRAFFIC: 'Traffic',
  OUTCOME_SALES: 'Sales',
  OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_AWARENESS: 'Awareness',
  OUTCOME_APP_PROMOTION: 'App promotion',
};

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, 'required').max(200, 'tooLong'),
  objective: z.enum(CAMPAIGN_OBJECTIVES),
});

export type CreateCampaignFormValues = z.infer<typeof createCampaignSchema>;

// ── Launch ad from creative (Meta) ───────────────────────────────────────────

/** Meta call-to-action button values accepted by the ad creative. */
export const CALL_TO_ACTIONS = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'SUBSCRIBE',
  'CONTACT_US',
  'BOOK_TRAVEL',
  'GET_OFFER',
  'DOWNLOAD',
] as const;

export type CallToAction = (typeof CALL_TO_ACTIONS)[number];

export const CTA_LABEL: Record<CallToAction, string> = {
  LEARN_MORE: 'Learn more',
  SHOP_NOW: 'Shop now',
  SIGN_UP: 'Sign up',
  SUBSCRIBE: 'Subscribe',
  CONTACT_US: 'Contact us',
  BOOK_TRAVEL: 'Book now',
  GET_OFFER: 'Get offer',
  DOWNLOAD: 'Download',
};

/**
 * Minimal launch-from-creative form. `optimizationGoal`/`billingEvent` default
 * server-side-friendly values (LINK_CLICKS / IMPRESSIONS); `targeting` is built
 * from the 2-letter country in the dialog. Budget is coerced from the input.
 */
export const launchAdSchema = z.object({
  generatedAssetId: z.string().trim().min(1, 'required').max(64, 'tooLong'),
  adsetName: z.string().trim().min(1, 'required').max(200, 'tooLong'),
  dailyBudget: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && v > 0, 'invalidNumber'),
  objective: z.enum(CAMPAIGN_OBJECTIVES),
  link: z.string().trim().url('invalidUrl').max(2000, 'tooLong'),
  primaryText: z.string().trim().min(1, 'required').max(2000, 'tooLong'),
  callToAction: z.enum(CALL_TO_ACTIONS),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'invalidCountry')
    .transform((v) => v.toUpperCase()),
});

export type LaunchAdFormValues = z.input<typeof launchAdSchema>;
export type LaunchAdFormOutput = z.output<typeof launchAdSchema>;

// ── Scaling-rule enums ───────────────────────────────────────────────────────

export const RULE_METRICS: RuleMetric[] = ['SPEND', 'CPL', 'CTR', 'LEADS', 'CLICKS', 'IMPRESSIONS'];
export const RULE_OPERATORS: RuleOperator[] = ['GT', 'LT', 'GTE', 'LTE'];
export const RULE_ACTIONS: RuleAction[] = ['INCREASE_BUDGET', 'DECREASE_BUDGET', 'PAUSE', 'RESUME'];

export const METRIC_LABEL: Record<RuleMetric, string> = {
  SPEND: 'Spend',
  CPL: 'Cost per lead',
  CTR: 'CTR',
  LEADS: 'Leads',
  CLICKS: 'Clicks',
  IMPRESSIONS: 'Impressions',
};

export const OPERATOR_LABEL: Record<RuleOperator, string> = {
  GT: '> (greater than)',
  LT: '< (less than)',
  GTE: '≥ (at least)',
  LTE: '≤ (at most)',
};

export const OPERATOR_SYMBOL: Record<RuleOperator, string> = {
  GT: '>',
  LT: '<',
  GTE: '≥',
  LTE: '≤',
};

export const ACTION_LABEL: Record<RuleAction, string> = {
  INCREASE_BUDGET: 'Increase budget',
  DECREASE_BUDGET: 'Decrease budget',
  PAUSE: 'Pause',
  RESUME: 'Resume',
};

/** Actions that require a percentage `actionValue`. */
export const BUDGET_ACTIONS = new Set<RuleAction>(['INCREASE_BUDGET', 'DECREASE_BUDGET']);

/** A blank-string-tolerant optional positive number, coerced from form inputs. */
const optionalNumber = z
  .union([z.string(), z.number()])
  .transform((v) => (v === '' || v == null ? undefined : Number(v)))
  .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), 'invalidNumber')
  .optional();

export const ruleSchema = z
  .object({
    name: z.string().trim().min(1, 'required').max(200, 'tooLong'),
    adAccountId: z.string().min(1, 'required'),
    metric: z.enum(['SPEND', 'CPL', 'CTR', 'LEADS', 'CLICKS', 'IMPRESSIONS']),
    operator: z.enum(['GT', 'LT', 'GTE', 'LTE']),
    threshold: z
      .union([z.string(), z.number()])
      .transform((v) => Number(v))
      .refine((v) => Number.isFinite(v), 'invalidNumber'),
    windowDays: z
      .union([z.string(), z.number()])
      .transform((v) => (v === '' || v == null ? undefined : Number(v)))
      // Mirror the backend @IsInt @Min(1) @Max(90) so an ordinary value like 180
      // gets an inline error instead of a raw server 400.
      .refine((v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 90), 'invalidNumber')
      .optional(),
    action: z.enum(['INCREASE_BUDGET', 'DECREASE_BUDGET', 'PAUSE', 'RESUME']),
    actionValue: optionalNumber,
    maxBudget: optionalNumber,
    minBudget: optionalNumber,
    cooldownHours: optionalNumber,
    enabled: z.boolean(),
  })
  .refine(
    (v) => !BUDGET_ACTIONS.has(v.action) || (v.actionValue != null && v.actionValue > 0),
    { path: ['actionValue'], message: 'required' },
  );

export type RuleFormValues = z.input<typeof ruleSchema>;
export type RuleFormOutput = z.output<typeof ruleSchema>;
