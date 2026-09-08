import {
  AI_EXECUTION_MODES,
  AI_MCP_GRACE_MS,
  aiGraceCutoff,
  effectiveAiExecution,
  platformMayRun,
} from './ai-execution';

/**
 * MCP first, the platform key as fallback — expressed small enough that the
 * copy of this rule inside a SQL claim predicate can be pinned against it.
 */
describe('effectiveAiExecution', () => {
  it('honours an explicit MCP', () => {
    expect(effectiveAiExecution('MCP', false)).toBe('MCP');
  });

  it('reads AUTO as MCP only while a Claude is actually connected', () => {
    expect(effectiveAiExecution('AUTO', true)).toBe('MCP');
    expect(effectiveAiExecution('AUTO', false)).toBe('SERVER');
  });

  it('honours MCP_ONLY whatever the connection signal says', () => {
    // It is a promise that the platform key will not be used. A promise that
    // breaks itself the moment a heuristic decides nobody is connected is not
    // a promise — the honest outcome is a queue that visibly waits.
    expect(effectiveAiExecution('MCP_ONLY', false)).toBe('MCP_ONLY');
    expect(effectiveAiExecution('MCP_ONLY', true)).toBe('MCP_ONLY');
  });

  it.each([[null], [undefined], ['SERVER'], ['mcp'], ['MCP_ONLY '], ['SOMETHING_NEW']])(
    'fails safe towards SERVER for %p',
    (stored) => {
      // A null from a row this code did not write, a typo, a value from a
      // future migration. Guessing MCP hands a queue to a client that does not
      // exist; guessing SERVER only costs money.
      expect(effectiveAiExecution(stored as string, true)).toBe('SERVER');
    },
  );

  it('never invents a mode outside the declared set', () => {
    for (const mode of AI_EXECUTION_MODES) {
      expect(['SERVER', 'MCP', 'MCP_ONLY']).toContain(effectiveAiExecution(mode, true));
      expect(['SERVER', 'MCP', 'MCP_ONLY']).toContain(effectiveAiExecution(mode, false));
    }
  });
});

describe('platformMayRun', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const justNow = new Date(now.getTime() - 1000);
  const longAgo = new Date(now.getTime() - AI_MCP_GRACE_MS - 1000);

  it('runs immediately on SERVER', () => {
    expect(platformMayRun('SERVER', justNow, now)).toBe(true);
  });

  it('waits out the grace window on MCP, then takes over', () => {
    expect(platformMayRun('MCP', justNow, now)).toBe(false);
    expect(platformMayRun('MCP', longAgo, now)).toBe(true);
  });

  it('NEVER runs on MCP_ONLY, however long the job has waited', () => {
    // The whole point of the mode. A grace window that eventually fires is a
    // preference; this is the guarantee.
    expect(platformMayRun('MCP_ONLY', longAgo, now)).toBe(false);
    expect(
      platformMayRun('MCP_ONLY', new Date(now.getTime() - 365 * 24 * 3600_000), now),
    ).toBe(false);
  });

  it('takes over exactly AT the cutoff, not a millisecond later', () => {
    // An off-by-one here is a job that sits one tick longer than the window
    // says, forever, on every workspace.
    expect(platformMayRun('MCP', aiGraceCutoff(now), now)).toBe(true);
    expect(platformMayRun('MCP', new Date(aiGraceCutoff(now).getTime() + 1), now)).toBe(false);
  });

  it('measures the window in minutes, not the hours research uses', () => {
    // A customer waiting on a reply is compared against their patience, not
    // against the morning a nightly job exists to protect.
    expect(AI_MCP_GRACE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});
