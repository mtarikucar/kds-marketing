import { request, seg } from './client';
import type {
  BudgetItemInput,
  BudgetItemOut,
  BudgetSpend,
  BudgetSpendOut,
  UpdateBudgetItemInput,
} from './types';

/** The server's default spend page, asked for explicitly so "is there more?" is decidable. */
export const SPEND_PAGE_SIZE = 50;

/** `GET /api/budget/items`: oldest first, with what was spent in the current period. */
export function listBudgetItems(): Promise<BudgetItemOut[]> {
  return request('GET', '/api/budget/items');
}

/** `POST /api/budget/items` (`201`): the unit must fit the kind. */
export function createBudgetItem(input: BudgetItemInput): Promise<BudgetItemOut> {
  return request('POST', '/api/budget/items', {
    body: { name: input.name, kind: input.kind, unit: input.unit, cap: input.cap, period: input.period, ...(input.general === undefined ? {} : { general: input.general }) },
  });
}

/**
 * `PATCH /api/budget/items/{id}`: only the fields given are sent (the server refuses any other,
 * the kind and unit among them, and an edit naming none).
 */
export function updateBudgetItem(id: string, input: UpdateBudgetItemInput): Promise<BudgetItemOut> {
  const body: Record<string, unknown> = {};
  if (input.general !== undefined) body.general = input.general;
  if (input.name !== undefined) body.name = input.name;
  if (input.cap !== undefined) body.cap = input.cap;
  if (input.period !== undefined) body.period = input.period;
  return request('PATCH', `/api/budget/items/${seg(id)}`, { body });
}

/** `POST /api/budget/items/{id}/retire`: final; its links go, its spend history stays. */
export function retireBudgetItem(id: string): Promise<BudgetItemOut> {
  return request('POST', `/api/budget/items/${seg(id)}/retire`, { body: { confirm: true } });
}

/** `POST /api/budget/items/{id}/spend` (`201`): `amount` in the item's unit, positive. */
export function recordSpend(
  itemId: string,
  input: { amount: number; reference?: string },
): Promise<BudgetSpendOut> {
  const body: Record<string, unknown> = { amount: input.amount };
  if (input.reference) body.reference = input.reference;
  return request('POST', `/api/budget/items/${seg(itemId)}/spend`, { body });
}

export interface SpendQuery {
  limit?: number;
  /** The previous page's last entry: its `at` and its `id`, always together. */
  before_at?: string;
  before_id?: string;
}

/**
 * `GET /api/budget/items/{id}/spend`: one page, newest first. Any other parameter is `422`, so
 * only the three known ones are ever sent.
 */
export function listSpend(itemId: string, query: SpendQuery = {}): Promise<BudgetSpend[]> {
  return request('GET', `/api/budget/items/${seg(itemId)}/spend`, {
    query: {
      limit: query.limit ?? SPEND_PAGE_SIZE,
      before_at: query.before_at,
      before_id: query.before_id,
    },
  });
}

export const SPENDING_MODULES = ['ads', 'inbox', 'outreach', 'calls', 'social'] as const;
export type SpendingModule = typeof SPENDING_MODULES[number];
export interface Stop {
  revision: number; all: boolean; modules: string[];
  paused: { module: string; title: string; state: 'paused' | 'pausing' }[];
}
export interface ItemBreakdown {
  item_id: string;
  /** What no module spent: entries a person or an agent recorded by hand. */
  unattributed_minor?: number;
  /** The general ad budget only: what open ad campaigns still hold of it now; absent when none. */
  held_minor?: number;
  modules: { module: SpendingModule; spent_minor: number; campaigns: { campaign_id: string; title: string; spent_minor: number }[] }[];
}
export interface Breakdown { items: ItemBreakdown[]; stop: Stop }
export function budgetBreakdown(from: string, until: string) {
  return request<Breakdown>('GET', '/api/budget/breakdown', { query: { from, until } });
}
export function stopSpending(body: { scope: 'all' | { module: string }; stopped: boolean; expected_revision: number }) {
  return request<Stop>('POST', '/api/budget/stop', { body });
}
