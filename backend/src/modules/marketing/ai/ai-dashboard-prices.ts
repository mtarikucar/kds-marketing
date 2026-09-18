import type { CallTokens } from './ai-model-prices';

interface DashboardPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Standard Claude API list prices in USD per million tokens, verified 2026-09-18.
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
 * Exact IDs only: a new version or provider prefix needs its own verification.
 * Source details and limitations: docs/ops/token-price-sources.md.
 */
const PRICES = new Map<string, readonly [number, number]>([
  ['claude-opus-4-20250514', [15, 75]],
  ['claude-opus-4-1-20250805', [15, 75]],
  ['claude-opus-4-5-20251101', [5, 25]],
  ['claude-opus-4-5', [5, 25]],
  ['claude-opus-4-6', [5, 25]],
  ['claude-opus-4-7', [5, 25]],
  ['claude-opus-4-8', [5, 25]],
  ['claude-opus-5', [5, 25]],
  ['claude-sonnet-4-20250514', [3, 15]],
  ['claude-sonnet-4-5-20250929', [3, 15]],
  ['claude-sonnet-4-5', [3, 15]],
  ['claude-sonnet-4-6', [3, 15]],
  ['claude-sonnet-5', [2, 10]],
  ['claude-3-5-haiku-20241022', [0.8, 4]],
  ['claude-haiku-4-5-20251001', [1, 5]],
  ['claude-haiku-4-5', [1, 5]],
]);

/** All four returned rates are USD per million tokens; cacheWrite assumes 5m. */
export function dashboardPriceFor(model: string): DashboardPrice | null {
  const price = PRICES.get(model);
  if (!price) return null;
  const [input, output] = price;
  return { input, output, cacheWrite: input * 1.25, cacheRead: input / 10 };
}

/**
 * List-price estimate from measured usage, not an invoice amount.
 * AiUsageLog has aggregate cache writes only: assume the 5-minute 1.25x rate,
 * not the 1-hour 2x rate. Cache tokens are separate from inputTokens.
 * Standard pricing only; no batch or context-based adjustments are inferred.
 * Keep sub-microdollar amounts for aggregation; round only for display.
 * Unknown models stay null even if a web-search subtotal could be computed.
 */
export function dashboardUsdFor(
  model: string,
  tokens: CallTokens,
): number | null {
  const price = dashboardPriceFor(model);
  if (!price) return null;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      (tokens.cacheWriteTokens ?? 0) * price.cacheWrite +
      (tokens.cacheReadTokens ?? 0) * price.cacheRead) /
      1_000_000 +
    (tokens.webSearches ?? 0) * (10 / 1000)
  );
}
