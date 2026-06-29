/** Pure row helpers backing the visual editors for the steps that previously
 *  required raw JSON (branch conditions, update_lead set). No React here. */

export interface Condition {
  field: string;
  op: string;
  value: string;
}

/**
 * Comparison operators offered in the branch condition builder. These MUST be a
 * subset of the backend DSL's FILTER_OPS (workflow-dsl.schema.ts:
 * ['eq','neq','in','contains','gte','lte','exists']) — every workflow write
 * re-validates the DSL through that Zod enum, so an unknown op (the old 'ne' /
 * 'gt' / 'lt') makes the WHOLE save throw 400. The builder also feeds a single
 * TEXT value, so non-scalar ops are excluded: 'in' wants an array and 'exists' a
 * bool — a string value silently never matches either. That leaves the scalar,
 * string-comparable ops below.
 */
export const CONDITION_OPS = ['eq', 'neq', 'contains', 'gte', 'lte'] as const;

/** Human-readable labels for the operators (the Select still stores the op value). */
export const CONDITION_OP_LABELS: Record<(typeof CONDITION_OPS)[number], string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  gte: '≥',
  lte: '≤',
};

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
