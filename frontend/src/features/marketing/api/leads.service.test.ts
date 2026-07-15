import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./marketingApi', () => ({ default: { get } }));

import { exportLeadsCsv } from './leads.service';

/**
 * Guards the root-cause fix: the CSV export must strip empty-string/null/
 * undefined filters before they reach the query string. axios only omits
 * null/undefined, so a bare `assignmentStatus=` (the default "All" state) would
 * otherwise hit the backend LeadFilterDto — whose `assignmentStatus` is
 * @IsIn([...]) with no empty-string coercion — and 400, breaking Export in its
 * most common state.
 */
describe('exportLeadsCsv — empty-filter param stripping', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: new Blob(['id,name\n'], { type: 'text/csv' }) });
    // jsdom lacks the blob-URL download plumbing exportLeadsCsv uses.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  it('drops every empty-string filter (the default "All" state) so the request validates', async () => {
    await exportLeadsCsv({ search: '', status: '', source: '', businessType: '', assignmentStatus: '' });

    expect(get).toHaveBeenCalledTimes(1);
    const config = get.mock.calls[0][1];
    // No bare `assignmentStatus=` — every empty filter is gone.
    expect(config.params).toEqual({});
    expect(config.params).not.toHaveProperty('assignmentStatus');
  });

  it('keeps set filters and drops only the empty ones', async () => {
    await exportLeadsCsv({ search: 'ann', status: '', assignmentStatus: 'mine', page: 1, limit: 50 });

    const config = get.mock.calls[0][1];
    expect(config.params).toEqual({ search: 'ann', assignmentStatus: 'mine', page: 1, limit: 50 });
  });

  it('keeps falsy-but-valid values such as page 0 (only ""/null/undefined are dropped)', async () => {
    await exportLeadsCsv({ page: 0, assignmentStatus: 'assigned' } as never);

    const config = get.mock.calls[0][1];
    expect(config.params).toEqual({ page: 0, assignmentStatus: 'assigned' });
  });
});
