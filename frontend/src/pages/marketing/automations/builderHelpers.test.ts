import { describe, it, expect } from 'vitest';
import {
  addCondition, removeCondition, patchCondition,
  setObjectToRows, rowsToSetObject,
} from './builderHelpers';

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
