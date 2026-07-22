import { z } from 'zod';
import { MarketingStrategyBrief } from './strategy.types';

/**
 * Strategy Engine — the zod contract for the synthesized `MarketingStrategy.brief`.
 * Because the brief is stored as Json (so its shape can evolve without a
 * migration), this schema is the validation boundary: synthesis MUST pass its
 * output through `validateBrief` before upserting the strategy. Mirrors
 * `MarketingStrategyBrief` in strategy.types.ts.
 */

const channelSchema = z.object({
  key: z.string().min(1),
  fitScore: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

const contentPillarSchema = z.object({
  title: z.string().min(1),
  angle: z.string().min(1),
  formats: z.array(z.string().min(1)),
  tone: z.string().min(1),
});

export const marketingStrategyBriefSchema = z.object({
  identity: z.object({
    product: z.string().min(1),
    voice: z.string().min(1),
    positioning: z.string().min(1),
    usp: z.string().min(1),
  }),
  audience: z.string().min(1),
  channels: z.array(channelSchema).min(1),
  contentPillars: z.array(contentPillarSchema).min(1),
  goals: z.object({
    objective: z.string().min(1),
    kpis: z.array(z.string().min(1)),
  }),
  budget: z.string().min(1),
  competitors: z.array(z.string()),
});

/**
 * Validate an untrusted value as a `MarketingStrategyBrief`. Returns a discriminated
 * result so callers can branch without try/catch and surface a human-readable error.
 */
export function validateBrief(
  x: unknown,
): { ok: true; brief: MarketingStrategyBrief } | { ok: false; error: string } {
  const parsed = marketingStrategyBriefSchema.safeParse(x);
  if (parsed.success) {
    return { ok: true, brief: parsed.data as MarketingStrategyBrief };
  }
  const issue = parsed.error.issues[0];
  const path = issue?.path?.join('.') || '(root)';
  const error = issue ? `${path}: ${issue.message}` : 'invalid brief';
  return { ok: false, error };
}
