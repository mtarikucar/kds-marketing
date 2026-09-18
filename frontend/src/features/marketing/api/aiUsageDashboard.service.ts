import marketingApi from './marketingApi';

export interface AiUsageRow {
  action: string;
  label: string;
  category: string;
  kind: 'TOKEN' | 'MEDIA' | 'EXTERNAL' | 'ENTRY';
  calls: number | null;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  webSearches: number;
  costUsd: number | null;
  averageTokens: number | null;
  averageCostUsd: number | null;
  unpricedCalls: number;
  creditRate: number | null;
  creditUnit: 'call' | 'minute' | 'image' | 'second' | 'dynamic';
  models: Array<{
    model: string;
    calls: number;
    tokens: number | null;
    costUsd: number | null;
    priceKnown: boolean;
  }>;
}

export interface AiUsageDashboard {
  generatedAt: string;
  currency: 'USD';
  period: {
    month: string;
    timezone: string;
    from: string;
    to: string;
    elapsedDays: number;
    totalDays: number;
  };
  totals: {
    tokens: number;
    calls: number;
    llmCostUsd: number;
    mediaCostUsd: number;
    knownCostUsd: number;
    unpricedCalls: number;
    unpricedMediaJobs: number;
  };
  forecast: {
    tokens: number | null;
    costUsd: number | null;
    dailyTokens: number | null;
    dailyCostUsd: number | null;
    observedDays: number;
    remainingDays: number;
    basis: 'MONTH_TO_DATE';
    reason: 'INSUFFICIENT_HISTORY' | 'NO_ACTIVITY' | null;
  };
  daily: Array<{
    day: string;
    tokens: number;
    calls: number;
    llmCostUsd: number;
    mediaCostUsd: number;
    knownCostUsd: number;
  }>;
  rows: AiUsageRow[];
  coverage: { partial: boolean; untrackedActions: string[]; unmappedActions: string[] };
}

/** Current calendar month in the active workspace timezone; independent of policy reads. */
export const getAiUsageDashboard = (): Promise<AiUsageDashboard> =>
  marketingApi.get('/ai/usage-dashboard').then((response) => response.data);
