import type { AiUsageDashboard } from '@/features/marketing/api/aiUsageDashboard.service';

/** Deliberately mixed coverage: recorded API usage, unmeasured local work and a retired action. */
export function usageDashboardFixture(): AiUsageDashboard {
  return {
    generatedAt: '2026-09-11T00:00:00Z', currency: 'USD' as const,
    period: { month: '2026-09', timezone: 'Europe/Istanbul', from: '2026-08-31T21:00:00Z', to: '2026-09-30T21:00:00Z', elapsedDays: 10, totalDays: 30 },
    totals: { tokens: 12000, calls: 5, llmCostUsd: 3.5, mediaCostUsd: 1, knownCostUsd: 4.5, unpricedCalls: 0, unpricedMediaJobs: 0 },
    forecast: { tokens: 36000 as number | null, costUsd: 13.5 as number | null, dailyTokens: 1200 as number | null, dailyCostUsd: .45 as number | null, observedDays: 10, remainingDays: 20, basis: 'MONTH_TO_DATE' as const, reason: null as 'INSUFFICIENT_HISTORY' | 'NO_ACTIVITY' | null },
    daily: [{ day: '2026-09-10', tokens: 12000, calls: 5, llmCostUsd: 3.5, mediaCostUsd: 1, knownCostUsd: 4.5 }],
    rows: [
      { action: 'future.action', label: 'Future action', category: 'New category', kind: 'TOKEN' as const, calls: 4, tokens: 12000, inputTokens: 5000, outputTokens: 2000, cacheWriteTokens: 1000, cacheReadTokens: 4000, webSearches: 0, costUsd: 3.5, averageTokens: 3000, averageCostUsd: .875, unpricedCalls: 0, creditRate: 2, creditUnit: 'call' as const, models: [{ model: 'claude-test', calls: 4, tokens: 12000, costUsd: 3.5, priceKnown: true }] },
      { action: 'voice.transcribe', label: 'Transcribe calls', category: 'Voice', kind: 'EXTERNAL' as const, calls: null, tokens: null, inputTokens: null, outputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, webSearches: 0, costUsd: null, averageTokens: null, averageCostUsd: null, unpricedCalls: 0, creditRate: null, creditUnit: 'minute' as const, models: [] },
      { action: 'retired.research', label: 'Legacy research', category: 'Research', kind: 'MEDIA' as const, calls: 1, tokens: null, inputTokens: null, outputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, webSearches: 0, costUsd: 1, averageTokens: null, averageCostUsd: 1, unpricedCalls: 0, creditRate: null, creditUnit: 'dynamic' as const, models: [] },
    ],
    coverage: { partial: true, untrackedActions: ['voice.transcribe'], unmappedActions: ['retired.research'] },
  };
}
