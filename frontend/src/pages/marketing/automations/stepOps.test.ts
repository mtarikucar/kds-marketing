import { describe, it, expect } from 'vitest';
import { appendStep, deleteStepAt, moveStepAt } from './stepOps';

describe('appendStep', () => {
  it('appends a default-configured step of the given type', () => {
    const out = appendStep([], 'send_sms');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'send_sms' });
    expect(typeof (out[0] as { body?: string }).body).toBe('string');
  });
  it('does not mutate the input array', () => {
    const input = [{ type: 'wait', mode: 'duration', seconds: 60 }];
    appendStep(input, 'add_tag');
    expect(input).toHaveLength(1);
  });
});

describe('deleteStepAt', () => {
  it('removes the step and remaps a later branch.elseGoto down', () => {
    const steps = [
      { type: 'branch', filters: [], elseGoto: 2 },
      { type: 'notify_user', message: 'x' },
      { type: 'stop_workflow' },
    ];
    const out = deleteStepAt(steps, 1, undefined);
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]).toMatchObject({ elseGoto: 1 }); // 2 -> 1
  });
  it('falls a goto goal back to exit when its target step is deleted', () => {
    const steps = [{ type: 'notify_user', message: 'a' }, { type: 'notify_user', message: 'b' }];
    const out = deleteStepAt(steps, 1, { onMet: 'goto', gotoStep: 1, filters: [] });
    expect(out.goal).toMatchObject({ onMet: 'exit' });
  });
});

describe('moveStepAt', () => {
  it('swaps adjacent steps', () => {
    const steps = [{ type: 'send_sms', body: 'a' }, { type: 'send_sms', body: 'b' }];
    const out = moveStepAt(steps, 0, 1, undefined);
    expect(out.steps.map((s) => (s as { body: string }).body)).toEqual(['b', 'a']);
  });
  it('is a no-op at the array edge', () => {
    const steps = [{ type: 'send_sms', body: 'a' }];
    expect(moveStepAt(steps, 0, -1, undefined).steps).toEqual(steps);
  });
});
