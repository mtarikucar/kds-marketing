import { describe, it, expect } from 'vitest';
import { fromWorkflowDto, fromTemplate, toSavePayload } from './workflowPayload';

describe('fromWorkflowDto', () => {
  it('maps a saved workflow to builder state and leaves goal as-is (undefined)', () => {
    const s = fromWorkflowDto({
      id: '1', name: 'W', status: 'ACTIVE', version: 1,
      trigger: { type: 'lead.created', filters: [{ field: 'a' }] },
      steps: [{ type: 'send_sms', body: 'hi' }],
      goal: { onMet: 'exit', filters: [] },
    });
    expect(s).toEqual({
      name: 'W', triggerType: 'lead.created', filters: [{ field: 'a' }],
      steps: [{ type: 'send_sms', body: 'hi' }], goal: undefined,
    });
  });
  it('defaults trigger/filters/steps when missing', () => {
    const s = fromWorkflowDto({ id: '1', name: 'W', status: 'DRAFT', version: 1 });
    expect(s.triggerType).toBe('lead.created');
    expect(s.filters).toEqual([]);
    expect(s.steps).toEqual([]);
  });
});

describe('fromTemplate', () => {
  it('carries the template goal so Save does not drop it', () => {
    const s = fromTemplate({
      key: 'k', name: 'T', description: '', category: 'c',
      trigger: { type: 'form.submitted', filters: [] }, steps: [], goal: { onMet: 'exit', filters: [] },
    });
    expect(s.goal).toEqual({ onMet: 'exit', filters: [] });
    expect(s.triggerType).toBe('form.submitted');
  });
});

describe('toSavePayload', () => {
  const base = { name: 'W', triggerType: 'lead.created', filters: [], steps: [{ type: 'send_sms', body: 'x' }] };
  it('omits goal when undefined (leave-as-is on PATCH)', () => {
    expect('goal' in toSavePayload({ ...base, goal: undefined })).toBe(false);
  });
  it('includes goal:null to clear', () => {
    expect(toSavePayload({ ...base, goal: null }).goal).toBeNull();
  });
  it('includes a set goal', () => {
    expect(toSavePayload({ ...base, goal: { onMet: 'exit', filters: [] } }).goal).toEqual({ onMet: 'exit', filters: [] });
  });
  it('nests trigger and passes steps through', () => {
    const p = toSavePayload({ ...base, goal: undefined });
    expect(p).toMatchObject({ name: 'W', trigger: { type: 'lead.created', filters: [] }, steps: [{ type: 'send_sms', body: 'x' }] });
  });
});
