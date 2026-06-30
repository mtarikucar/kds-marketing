import { describe, it, expect } from 'vitest';
import { filterWorkflows } from './listFilters';

const rows = [
  { id: '1', name: 'Welcome flow', status: 'ACTIVE', version: 1, trigger: { type: 'lead.created' } },
  { id: '2', name: 'Win-back', status: 'PAUSED', version: 1, trigger: { type: 'lead.status_changed' } },
];

describe('filterWorkflows', () => {
  it('returns all with empty search + ALL status', () => {
    expect(filterWorkflows(rows, { search: '', status: 'ALL' })).toHaveLength(2);
  });
  it('matches name case-insensitively', () => {
    expect(filterWorkflows(rows, { search: 'win', status: 'ALL' }).map((r) => r.id)).toEqual(['2']);
  });
  it('matches trigger type', () => {
    expect(filterWorkflows(rows, { search: 'status_changed', status: 'ALL' }).map((r) => r.id)).toEqual(['2']);
  });
  it('filters by status', () => {
    expect(filterWorkflows(rows, { search: '', status: 'ACTIVE' }).map((r) => r.id)).toEqual(['1']);
  });
});
