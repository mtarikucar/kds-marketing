import type { AiUsageRow } from '@/features/marketing/api/aiUsageDashboard.service';
import type { AiExecutionProvider } from '@/features/marketing/api/aiExecutionPolicy.service';

export function usageNumbers(language: string) {
  const numbers = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const dollars = new Intl.NumberFormat(language, {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
  return {
    number: (value: number | null | undefined) => value == null ? '—' : numbers.format(value),
    money: (value: number | null | undefined) => value == null ? '—' : (
      value > 0 && value < .000001 ? `<${dollars.format(.000001)}` : dollars.format(value)
    ),
  };
}

/** A zero API-history bucket says nothing about work done through MCP/local. */
export function unmeasuredProvider(row: AiUsageRow | undefined, provider?: AiExecutionProvider) {
  return provider !== undefined && provider !== 'API' && row?.kind === 'TOKEN' && row.calls === 0;
}
