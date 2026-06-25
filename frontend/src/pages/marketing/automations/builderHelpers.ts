/** Pure row helpers backing the visual editors for the steps that previously
 *  required raw JSON (branch conditions, update_lead set). No React here. */

export interface Condition {
  field: string;
  op: string;
  value: string;
}

/** Comparison operators offered in the branch condition builder (mirror the DSL). */
export const CONDITION_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'] as const;

export function addCondition(rows: Condition[]): Condition[] {
  return [...rows, { field: '', op: 'eq', value: '' }];
}

export function removeCondition(rows: Condition[], i: number): Condition[] {
  return rows.filter((_, idx) => idx !== i);
}

export function patchCondition(rows: Condition[], i: number, patch: Partial<Condition>): Condition[] {
  return rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
}

export interface SetRow {
  key: string;
  value: string;
}

/** A `update_lead.set` object → ordered editable rows. */
export function setObjectToRows(set: Record<string, unknown> | undefined): SetRow[] {
  return Object.entries(set ?? {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

/** Rows → a `set` object, dropping rows with a blank key. */
export function rowsToSetObject(rows: SetRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) if (key.trim()) out[key] = value;
  return out;
}
