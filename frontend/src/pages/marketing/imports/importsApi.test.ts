import { describe, it, expect } from 'vitest';
import { importPollInterval } from './importsApi';

/**
 * The import wizard's Progress step polls GET /imports/:id every 2s. The bug:
 * it polled forever, even after the job reached DONE/FAILED, so a user who left
 * the completed-import page open hammered the backend indefinitely. Polling must
 * stop the moment the job is terminal.
 */
describe('importPollInterval', () => {
  it('does not poll at all when polling is disabled', () => {
    expect(importPollInterval(false, 'RUNNING')).toBe(false);
    expect(importPollInterval(false, undefined)).toBe(false);
  });

  it('polls every 2s while the job is still in flight', () => {
    expect(importPollInterval(true, 'MAPPING')).toBe(2_000);
    expect(importPollInterval(true, 'RUNNING')).toBe(2_000);
    // Not yet loaded (first tick before the first response) — keep polling.
    expect(importPollInterval(true, undefined)).toBe(2_000);
  });

  it('STOPS polling once the job reaches a terminal state', () => {
    expect(importPollInterval(true, 'DONE')).toBe(false);
    expect(importPollInterval(true, 'FAILED')).toBe(false);
  });
});
