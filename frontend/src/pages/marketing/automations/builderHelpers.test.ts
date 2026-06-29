import { describe, it, expect } from 'vitest';
import {
  addCondition, removeCondition, patchCondition,
  setObjectToRows, rowsToSetObject, CONDITION_OPS, UPDATE_LEAD_FIELDS,
} from './builderHelpers';

// The backend evaluator + Zod enum is the contract:
//   backend/src/modules/marketing/workflows/workflow-dsl.schema.ts
//   FILTER_OPS = ['eq','neq','in','contains','gte','lte','exists']
// Every write re-validates the DSL (workflows.service.ts), so an op NOT in this
// set makes the WHOLE workflow save throw 400. The branch builder also feeds a
// single TEXT value, so it must not offer ops whose value is non-scalar:
//   'in' needs an array, 'exists' needs a bool — a string never matches those.
const BACKEND_FILTER_OPS = ['eq', 'neq', 'in', 'contains', 'gte', 'lte', 'exists'];
const NON_SCALAR_OPS = ['in', 'exists'];

describe('branch CONDITION_OPS ↔ backend contract', () => {
  it('only offers operators the backend Zod enum accepts (no ne/gt/lt)', () => {
    for (const op of CONDITION_OPS) expect(BACKEND_FILTER_OPS).toContain(op);
  });
  it('does not offer ops whose value cannot be a scalar string (in/exists)', () => {
    for (const op of CONDITION_OPS) expect(NON_SCALAR_OPS).not.toContain(op);
  });
  it('offers neq so the "is not" condition works end-to-end', () => {
    expect(CONDITION_OPS).toContain('neq');
  });
});

// The update_lead runtime (workflow-action.handler.ts) only APPLIES keys in its
// LEAD_WRITABLE allow-list; the DSL schema (z.record) accepts any key, so a
// field outside this set saves fine but is SILENTLY DROPPED at runtime. The
// editor must therefore offer only these fields. Keep in lock-step with backend.
const BACKEND_LEAD_WRITABLE = [
  'status', 'priority', 'notes', 'nextFollowUp',
  'businessName', 'contactPerson', 'city', 'region',
];

describe('update_lead writable-field contract', () => {
  it('offers exactly the backend-writable lead fields (no silently-dropped keys)', () => {
    expect([...UPDATE_LEAD_FIELDS].sort()).toEqual([...BACKEND_LEAD_WRITABLE].sort());
  });
});

describe('branch conditions', () => {
  it('adds a blank condition row', () => {
    expect(addCondition([])).toEqual([{ field: '', op: 'eq', value: '' }]);
  });
  it('patches one row by index, leaving others intact', () => {
    const rows = [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '2' }];
    expect(patchCondition(rows, 1, { value: '9' })[1]).toEqual({ field: 'b', op: 'eq', value: '9' });
    expect(patchCondition(rows, 1, { value: '9' })[0]).toEqual(rows[0]);
  });
  it('removes a row by index', () => {
    const rows = [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '2' }];
    expect(removeCondition(rows, 0)).toEqual([{ field: 'b', op: 'eq', value: '2' }]);
  });
});

describe('update_lead set <-> rows', () => {
  it('converts a set object to ordered rows', () => {
    expect(setObjectToRows({ status: 'CONTACTED', tier: 'A' }))
      .toEqual([{ key: 'status', value: 'CONTACTED' }, { key: 'tier', value: 'A' }]);
  });
  it('round-trips rows back to an object, dropping blank keys', () => {
    expect(rowsToSetObject([{ key: 'status', value: 'NEW' }, { key: '', value: 'x' }]))
      .toEqual({ status: 'NEW' });
  });
});
