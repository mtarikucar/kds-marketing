import { describe, it, expect } from 'vitest';
import { bulkDeleteToast, bulkAssignToast } from './leadsBulkToast';

// Mirror the app's i18n `t`: return the interpolated defaultValue. We keep the
// raw {{placeholders}} (enough to assert branch wording without a full i18n).
const t = (key: string, opts?: Record<string, unknown>) =>
  (opts?.defaultValue as string) ?? key;

describe('bulkDeleteToast', () => {
  it('surfaces the skipped count on a partial delete (some deleted, some protected)', () => {
    const out = bulkDeleteToast({ deleted: 7, skippedProtected: 3 }, t);
    expect(out.text).toMatch(/skipped/i);
    expect(out.tone).toBe('success');
  });

  it('is informational (not success) when everything selected was protected', () => {
    // Selecting only WON/converted leads deletes nothing — the old code toasted a
    // bare "0 deleted" success, reading as a broken no-op. Explain it instead.
    const out = bulkDeleteToast({ deleted: 0, skippedProtected: 2 }, t);
    expect(out.text).toMatch(/skipped/i);
    expect(out.tone).toBe('info');
  });

  it('shows a plain success message when nothing was skipped', () => {
    const out = bulkDeleteToast({ deleted: 5 }, t);
    expect(out.text).not.toMatch(/skipped/i);
    expect(out.tone).toBe('success');
  });
});

describe('bulkAssignToast', () => {
  it('explains a pure no-op (0 assigned — all already on that rep) instead of "0 assigned"', () => {
    const out = bulkAssignToast({ assigned: 0, unchanged: 5, skipped: [] }, t);
    expect(out.tone).toBe('info');
    expect(out.text).toMatch(/no change/i);
  });

  it('notes the leftover count on a partial reassign (skipped is an id array)', () => {
    const out = bulkAssignToast({ assigned: 6, unchanged: 3, skipped: ['x', 'y'] }, t);
    expect(out.tone).toBe('success');
    expect(out.text).toMatch(/unchanged/i);
  });

  it('plain success when every selected lead was reassigned', () => {
    const out = bulkAssignToast({ assigned: 4, unchanged: 0, skipped: [] }, t);
    expect(out.tone).toBe('success');
    expect(out.text).not.toMatch(/unchanged|no change/i);
  });
});
