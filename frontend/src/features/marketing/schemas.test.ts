import { describe, it, expect } from 'vitest';
import { taskSchema, leadSchema } from './schemas';

const base = {
  title: 'Call the lead',
  type: 'CALL' as const,
  priority: 'MEDIUM' as const,
};

const leadBase = {
  businessName: 'Acme Cafe',
  contactPerson: 'Jane',
  businessType: 'CAFE',
  priority: 'MEDIUM' as const,
};

describe('leadSchema source', () => {
  // CSV import (import.service.ts) stamps source='IMPORT' on rows with no
  // source column. Opening such a lead's edit form seeds source='IMPORT'; if
  // the enum rejects it the save 400s and the lead is un-editable — the same
  // class as the AI_RESEARCH/HARDWARE_QUOTE gap. IMPORT must round-trip.
  it('accepts source=IMPORT so CSV-imported leads stay editable', () => {
    const r = leadSchema.safeParse({ ...leadBase, source: 'IMPORT' });
    expect(r.success).toBe(true);
  });

  it('still rejects an unknown source', () => {
    const r = leadSchema.safeParse({ ...leadBase, source: 'NOPE' });
    expect(r.success).toBe(false);
  });
});

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
