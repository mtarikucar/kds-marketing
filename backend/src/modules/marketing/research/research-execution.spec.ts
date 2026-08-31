import {
  MCP_CONNECTION_STALE_DAYS,
  MCP_CONNECTION_STALE_MS,
  MCP_ACTIVITY_AGENT,
  RESEARCH_MCP_GRACE_HOURS,
  RESEARCH_MCP_GRACE_MS,
  RESEARCH_EXECUTION_MODES,
  effectiveResearchExecution,
  mcpActivityCutoff,
  researchGraceCutoff,
} from './research-execution';

/**
 * The two windows the whole "default to MCP, but never silently stop" design
 * rests on, and the fail-safe direction of the mode resolver.
 */
describe('research-execution — the effective lane', () => {
  it('an explicit MCP wins, connection or not', () => {
    expect(effectiveResearchExecution('MCP', false)).toBe('MCP');
    expect(effectiveResearchExecution('MCP', true)).toBe('MCP');
  });

  it('an explicit SERVER wins, connection or not', () => {
    expect(effectiveResearchExecution('SERVER', true)).toBe('SERVER');
    expect(effectiveResearchExecution('SERVER', false)).toBe('SERVER');
  });

  it('AUTO follows the connection', () => {
    expect(effectiveResearchExecution('AUTO', true)).toBe('MCP');
    expect(effectiveResearchExecution('AUTO', false)).toBe('SERVER');
  });

  /**
   * Same direction ResearchLeaseService.modeFor() and the console overview
   * already fail in: anything this code did not write means the PLATFORM is
   * still draining. Reading an unknown value as MCP would hand a queue to a
   * client that does not exist.
   */
  it('anything unknown reads as SERVER, even with a live connection', () => {
    for (const junk of [null, undefined, '', 'mcp', 'auto', 'nonsense']) {
      expect(effectiveResearchExecution(junk as never, true)).toBe('SERVER');
    }
  });

  it('offers exactly the three storable modes', () => {
    expect([...RESEARCH_EXECUTION_MODES]).toEqual(['AUTO', 'SERVER', 'MCP']);
  });
});

describe('research-execution — the two windows', () => {
  const NOW = new Date('2026-09-01T09:00:00.000Z');

  it('names the grace window rather than inlining a literal', () => {
    expect(RESEARCH_MCP_GRACE_HOURS).toBe(6);
    expect(RESEARCH_MCP_GRACE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('names the staleness threshold rather than inlining a literal', () => {
    expect(MCP_CONNECTION_STALE_DAYS).toBe(14);
    expect(MCP_CONNECTION_STALE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  /**
   * The cron enqueues at 03:00. Six hours puts the platform's takeover at
   * 09:00 — after every plausible overnight drainer has had its turn, and
   * still inside the morning the owner looks at the panel.
   */
  it('a job enqueued at 03:00 is the platform\'s at 09:00 and not before', () => {
    const cutoff = researchGraceCutoff(NOW);
    expect(cutoff.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('the MCP-activity cutoff is the staleness threshold back from now', () => {
    expect(mcpActivityCutoff(NOW).toISOString()).toBe('2026-08-18T09:00:00.000Z');
  });

  /**
   * The signal is an MCP TOOL CALL, not an api-key stamp — see the module doc.
   */
  it('keys the connection signal off the MCP agent-run marker', () => {
    expect(MCP_ACTIVITY_AGENT).toBe('mcp');
  });
});
