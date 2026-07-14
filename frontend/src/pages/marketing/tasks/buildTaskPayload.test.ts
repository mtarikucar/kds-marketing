import { describe, it, expect } from 'vitest';
import { buildTaskPayload } from './TasksPage';
import type { TaskFormValues } from '../../../features/marketing/schemas';

const base: TaskFormValues = {
  title: 'Follow up',
  type: 'CALL',
  priority: 'HIGH',
  dueDate: '2026-07-01',
  dueTime: '10:00',
  description: '',
  leadId: '',
  assignedToId: '',
} as TaskFormValues;

describe('buildTaskPayload', () => {
  it('EDIT: sends an explicit empty description so a blanked one is actually cleared', () => {
    const p = buildTaskPayload({ ...base, description: '' }, true);
    expect(p).toHaveProperty('description', '');
  });

  it('EDIT: keeps a set description', () => {
    const p = buildTaskPayload({ ...base, description: 'ring back at 3pm' }, true);
    expect(p.description).toBe('ring back at 3pm');
  });

  it('CREATE: omits an empty description (no "" stored)', () => {
    const p = buildTaskPayload({ ...base, description: '' }, false);
    expect(p).not.toHaveProperty('description');
  });

  it('omits empty leadId/assignedToId in both modes', () => {
    expect(buildTaskPayload(base, true)).not.toHaveProperty('leadId');
    expect(buildTaskPayload(base, false)).not.toHaveProperty('assignedToId');
    const withIds = buildTaskPayload({ ...base, leadId: 'l1', assignedToId: 'u1' }, true);
    expect(withIds.leadId).toBe('l1');
    expect(withIds.assignedToId).toBe('u1');
  });
});
