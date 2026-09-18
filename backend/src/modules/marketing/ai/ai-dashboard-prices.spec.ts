import { dashboardPriceFor, dashboardUsdFor } from './ai-dashboard-prices';
import type { CallTokens } from './ai-model-prices';

describe('dashboardPriceFor', () => {
  it.each<[string, number, number, number, number]>([
    ['claude-opus-4-20250514', 15, 75, 18.75, 1.5],
    ['claude-opus-4-1-20250805', 15, 75, 18.75, 1.5],
    ['claude-opus-4-5-20251101', 5, 25, 6.25, 0.5],
    ['claude-opus-4-5', 5, 25, 6.25, 0.5],
    ['claude-opus-4-6', 5, 25, 6.25, 0.5],
    ['claude-opus-4-7', 5, 25, 6.25, 0.5],
    ['claude-opus-4-8', 5, 25, 6.25, 0.5],
    ['claude-opus-5', 5, 25, 6.25, 0.5],
    ['claude-sonnet-4-20250514', 3, 15, 3.75, 0.3],
    ['claude-sonnet-4-5-20250929', 3, 15, 3.75, 0.3],
    ['claude-sonnet-4-5', 3, 15, 3.75, 0.3],
    ['claude-sonnet-4-6', 3, 15, 3.75, 0.3],
    ['claude-sonnet-5', 2, 10, 2.5, 0.2],
    ['claude-3-5-haiku-20241022', 0.8, 4, 1, 0.08],
    ['claude-haiku-4-5-20251001', 1, 5, 1.25, 0.1],
    ['claude-haiku-4-5', 1, 5, 1.25, 0.1],
  ])(
    'uses verified USD per million token rates for %s',
    (model, input, output, cacheWrite, cacheRead) => {
      expect(dashboardPriceFor(model)).toEqual({
        input,
        output,
        cacheWrite,
        cacheRead,
      });
    },
  );

  it.each([
    '',
    'unknown',
    'opus',
    'custom-claude-sonnet-4-6',
    'claude-opus-4-9',
    'claude-haiku-4-5-20990101',
    'claude-sonnet-4-6-latest',
    'claude-sonnet-4-6-fast',
    'anthropic.claude-sonnet-4-6',
    'claude-3-opus-20240229',
    '__proto__',
    'constructor',
  ])('leaves an unverified ID unpriced: %s', (model) => {
    expect(dashboardPriceFor(model)).toBeNull();
    expect(
      dashboardUsdFor(model, {
        inputTokens: 1000,
        outputTokens: 500,
        webSearches: 1,
      }),
    ).toBeNull();
  });
});

describe('dashboardUsdFor', () => {
  it('adds uncached input, output, 5-minute writes, reads, and search charges once', () => {
    const tokens: CallTokens = {
      inputTokens: 1000,
      outputTokens: 2000,
      cacheWriteTokens: 3000,
      cacheReadTokens: 4000,
      webSearches: 5,
    };
    // $0.003 + $0.030 + $0.01125 + $0.0012 + $0.050.
    expect(dashboardUsdFor('claude-sonnet-4-6', tokens)).toBeCloseTo(
      0.09545,
      12,
    );
  });

  it('defaults absent cache and search counters to zero', () => {
    expect(
      dashboardUsdFor('claude-opus-4-8', {
        inputTokens: 1000,
        outputTokens: 2000,
      }),
    ).toBeCloseTo(0.055, 12);
  });

  it('charges web searches even when token counts are zero', () => {
    expect(
      dashboardUsdFor('claude-haiku-4-5', {
        inputTokens: 0,
        outputTokens: 0,
        webSearches: 3,
      }),
    ).toBeCloseTo(0.03, 12);
  });

  it('returns zero only for known models with no measured usage', () => {
    const tokens: CallTokens = { inputTokens: 0, outputTokens: 0 };
    expect(dashboardUsdFor('claude-haiku-4-5', tokens)).toBe(0);
    expect(dashboardUsdFor('unknown', tokens)).toBeNull();
  });

  it('preserves sub-microdollar cache reads for later aggregation', () => {
    expect(
      dashboardUsdFor('claude-haiku-4-5-20251001', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1,
      }),
    ).toBeCloseTo(0.0000001, 15);
  });

  it('uses the historical Opus rate rather than the cheaper current family rate', () => {
    expect(
      dashboardUsdFor('claude-opus-4-1-20250805', {
        inputTokens: 1000,
        outputTokens: 2000,
      }),
    ).toBeCloseTo(0.165, 12);
  });
});
