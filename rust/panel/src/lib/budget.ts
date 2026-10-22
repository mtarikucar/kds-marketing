import type { TFunction } from 'i18next';
import type { SpendSource, Unit } from '@/api/types';
import { formatMoney, formatNumber } from './format';

/** A budget unit as shown: the currency code, the count's own label, or minutes. */
export function unitLabel(t: TFunction, unit: Unit): string {
  switch (unit.kind) {
    case 'currency':
    case 'count':
      return unit.value;
    case 'minutes':
      return t('budget.units.minutes');
  }
}

/** An amount in a budget unit: money from minor units, a count with its label, or minutes. */
export function formatAmount(t: TFunction, amount: number, unit: Unit, language: string): string {
  switch (unit.kind) {
    case 'currency':
      return formatMoney(amount, unit.value, language);
    case 'count':
      return `${formatNumber(amount, language)} ${unit.value}`;
    case 'minutes':
      return t('budget.minutesValue', { value: formatNumber(amount, language) });
  }
}

/** Who reported a spend. */
export function sourceLabel(t: TFunction, source: SpendSource): string {
  switch (source.kind) {
    case 'connector':
      return t('budget.sources.connector', { name: source.value });
    case 'agent':
      return t('budget.sources.agent');
    case 'human':
      return t('budget.sources.human');
  }
}
