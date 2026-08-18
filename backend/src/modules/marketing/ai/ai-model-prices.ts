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

/** USD cost of one measured call, to 6dp (a single cheap call is sub-cent). */
export function usdFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
