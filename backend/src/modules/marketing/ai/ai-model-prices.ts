/**
 * Vendor list price per model, USD per million tokens.
 *
 * `ai-credit-costs.ts` prices what we CHARGE; this prices what we PAY. Keeping
 * them apart matters: the credit table was derived from max_tokens ceilings and
 * its own header admits the numbers are guesses, so the only way to find out
 * whether a credit covers its cost is to compute the real side separately and
 * compare.
 *
 * Matched by substring on the resolved model id (AiUsageLog.model), because the
 * id carries a version that changes without the price changing.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

const PRICES: Array<{ match: string; price: ModelPrice }> = [
  { match: 'opus', price: { input: 5, output: 25 } },
  { match: 'sonnet', price: { input: 3, output: 15 } },
  { match: 'haiku', price: { input: 1, output: 5 } },
];

/** Unknown models are priced as the most expensive tier — never under-report. */
const FALLBACK: ModelPrice = { input: 5, output: 25 };

export function priceFor(model: string): ModelPrice {
  const id = (model || '').toLowerCase();
  return PRICES.find((p) => id.includes(p.match))?.price ?? FALLBACK;
}

/**
 * Prompt-cache multipliers on the INPUT rate. Writing a cache entry costs a
 * premium; reading one is the discount the whole feature exists for.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface CallTokens {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic reports these outside `input_tokens`; both default to 0. */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/**
 * USD cost of one measured call, to 6dp (a single cheap call is sub-cent).
 *
 * Cache tokens are counted at their own rates rather than ignored: once
 * caching is on, most input volume lives in them, and leaving them out would
 * report the saving as total instead of ~90% while hiding cache-write cost
 * completely.
 */
export function usdFor(model: string, tokens: CallTokens): number {
  const p = priceFor(model);
  const usd =
    (tokens.inputTokens * p.input +
      tokens.outputTokens * p.output +
      (tokens.cacheWriteTokens ?? 0) * p.input * CACHE_WRITE_MULTIPLIER +
      (tokens.cacheReadTokens ?? 0) * p.input * CACHE_READ_MULTIPLIER) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
