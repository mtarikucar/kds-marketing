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
    body: { name: input.name, kind: input.kind, unit: input.unit, cap: input.cap, period: input.period },
  });
}

/**
 * `PATCH /api/budget/items/{id}`: only the fields given are sent (the server refuses any other,
 * the kind and unit among them, and an edit naming none).
 */
export function updateBudgetItem(id: string, input: UpdateBudgetItemInput): Promise<BudgetItemOut> {
  const body: Record<string, unknown> = {};
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
