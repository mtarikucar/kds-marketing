import { describe, it, expect } from 'vitest';
import { taskSchema } from './schemas';

const base = {
  title: 'Call the lead',
  type: 'CALL' as const,
  priority: 'MEDIUM' as const,
};

describe('taskSchema', () => {
  it('accepts a past dueDate (past-date block removed)', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2000-01-01', dueTime: '09:00' });
    expect(r.success).toBe(true);
  });

  it('still requires dueDate', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '' });
    expect(r.success).toBe(false);
  });

  it('accepts a valid HH:mm dueTime', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2026-06-22', dueTime: '23:59' });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed dueTime', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2026-06-22', dueTime: '25:00' });
    expect(r.success).toBe(false);
  });

  it('allows dueTime to be omitted', () => {
    const r = taskSchema.safeParse({ ...base, dueDate: '2026-06-22' });
    expect(r.success).toBe(true);
  });
});
