import { describe, it, expect } from 'vitest';
import { toUpdateBody, type RoutineFormValues } from './routines';

const base: RoutineFormValues = {
  enabled: true,
  onEvent: true,
  cron: '',
  triggerUrl: '',
  triggerToken: '',
  eventCooldownSec: 300,
};

describe('toUpdateBody', () => {
  it('preserves a deliberate eventCooldownSec of 0 (does not rewrite it to 300)', () => {
    expect(toUpdateBody({ ...base, eventCooldownSec: 0 }).eventCooldownSec).toBe(0);
  });

  it('passes a normal cooldown through unchanged', () => {
    expect(toUpdateBody({ ...base, eventCooldownSec: 120 }).eventCooldownSec).toBe(120);
  });

  it('falls back to 300 only for a non-finite value', () => {
    expect(toUpdateBody({ ...base, eventCooldownSec: NaN as unknown as number }).eventCooldownSec).toBe(300);
  });

  it('maps empty cron/triggerUrl to null', () => {
    const body = toUpdateBody({ ...base, cron: '  ', triggerUrl: '' });
    expect(body.cron).toBeNull();
    expect(body.triggerUrl).toBeNull();
  });
});
