import * as fs from 'fs';
import * as path from 'path';
import { MCP_ACTIVITY_AGENT } from './research-execution';

/**
 * Drift tripwire for THE CONNECTION SIGNAL.
 *
 * `researchExecution = 'AUTO'` is now the default for every workspace, and the
 * whole three-way decision turns on one question: is there an `agent_runs` row
 * for this workspace with `agent = 'mcp'` inside the last 14 days? If yes, the
 * owner's Claude gets first refusal on the night's research and the model bill
 * moves to their subscription; if no, the platform drains it and pays.
 *
 * That question is only as good as the set of code paths that WRITE the value.
 * Two do today, and both of them genuinely are a Claude reaching this
 * workspace:
 *
 *   1. `McpInvokerService.invoke` — one run per MCP tool call, on both the
 *      api-key and the OAuth (Claude.ai / Desktop connector) paths. This is
 *      the signal proper: a tool call cannot happen any other way.
 *   2. `McpApprovalExecutorService.execute` — one run per approval a human
 *      releases from the queue. It cannot widen the answer on its own: an
 *      approval only exists because a tool call created it, that call already
 *      wrote its own (1) row, and `MCP_APPROVAL_TTL_MS` is 24 hours against a
 *      14-day window — so whenever a (2) row is inside the window a (1) row
 *      is too.
 *
 * A THIRD writer would be a silent lane change. Some future background job
 * that opens an AgentRun under `'mcp'` would flip its workspaces into MCP,
 * hand their research six hours of first-refusal latency every night, and
 * present as nothing at all — no error, no failing assertion, just research
 * arriving later than it used to and a bill that stopped moving. The comments
 * in `research-lease.service.ts`, `scheduled-job-runner.service.ts` and
 * `20260831180000_research_execution_auto/migration.sql` all lean on this set
 * being exactly two; this spec is what makes those comments enforceable.
 *
 * It scans production source (comments stripped) rather than mocking, because
 * the failure being guarded against is somebody ADDING a call site — which no
 * behavioural test of the existing call sites can see.
 */

const SRC_ROOT = path.resolve(__dirname, '../../..');

/** Every non-spec `.ts` under `src/`, as `{ rel, code }` with comments stripped. */
function productionSources(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
      out.push({
        rel: path.relative(SRC_ROOT, full).split(path.sep).join('/'),
        code: stripComments(fs.readFileSync(full, 'utf8')),
      });
    }
  };
  walk(SRC_ROOT);
  return out;
}

/**
 * Blank out `//` and block comments, keeping newlines so line numbers survive.
 *
 * Comments matter here: every file that DISCUSSES the signal mentions the
 * literal, and a tripwire that counted prose would fire on an edit to its own
 * documentation and be disabled within a week. String literals are left alone
 * — they are the thing being counted.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

interface Hit {
  rel: string;
  line: number;
  text: string;
}

function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const { rel, code } of productionSources()) {
    code.split('\n').forEach((line, i) => {
      if (pattern.test(line)) hits.push({ rel, line: i + 1, text: line.trim() });
      pattern.lastIndex = 0;
    });
  }
  return hits.sort((a, b) => `${a.rel}:${a.line}`.localeCompare(`${b.rel}:${b.line}`));
}

describe("the 'mcp' agent value — connection-signal tripwire", () => {
  /**
   * Every spelling of the value in production code, pinned as an exact set.
   *
   * This is the outer belt. The writer assertion below matches three known
   * spellings (`'mcp'`, `MCP_ACTIVITY_AGENT`, `MCP_AGENT`); this one exists so
   * a FOURTH spelling cannot be introduced without being noticed, which is the
   * only way a new writer could hide from it.
   */
  it('pins every place the literal exists at all', () => {
    const hits = scan(/(['"])mcp\1/);
    expect(hits.map((h) => `${h.rel} :: ${h.text}`)).toEqual([
      // WRITER — the signal proper.
      'modules/marketing/mcp/mcp-invoker.service.ts :: ' +
        "return await this.runs.track(workspaceId, { agent: 'mcp', goal: toolName, input: args }, async (agentRunId) => {",
      // WRITER — approval replay. Bounded by MCP_APPROVAL_TTL_MS; see the file docblock.
      'modules/marketing/mcp/mcp-approval-executor.service.ts :: ' +
        "{ agent: 'mcp', goal: `apply approval ${approvalId}: ${toolName}` },",
      // READER — the MCP console filters its session list on the same value.
      "modules/marketing/mcp/mcp-console.service.ts :: const MCP_AGENT = 'mcp';",
      // NOT AN AGENT VALUE — the REST route prefix. Listed so the set stays exact.
      "modules/marketing/mcp/mcp.controller.ts :: @Controller('mcp')",
      // READER — the constant this whole signal is named by.
      "modules/marketing/research/research-execution.ts :: export const MCP_ACTIVITY_AGENT = 'mcp';",
    ].sort());
  });

  /**
   * The set that actually decides who pays: `agent: <the mcp value>` in a
   * position that OPENS an AgentRun.
   *
   * A write is `agentRun.create` / `AgentRunService.start` / `.track`; a read is
   * a `where` clause. They are told apart by looking back a few lines for the
   * call being built, because the object literal and the call are usually on
   * different lines.
   */
  it('pins the exact set of code paths that WRITE it', () => {
    const VALUE = /agent:\s*(?:(['"])mcp\1|MCP_ACTIVITY_AGENT|MCP_AGENT)/;
    const OPENS_A_RUN = /\.(track|start)\(|agentRun\.create\(/;

    const writers: string[] = [];
    const readers: string[] = [];
    for (const { rel, code } of productionSources()) {
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (!VALUE.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        // Identified by file + source text, not by line number: a docblock
        // edit three files away must not turn this tripwire red, or it gets
        // deleted the first time it cries wolf.
        (OPENS_A_RUN.test(context) ? writers : readers).push(`${rel} :: ${line.trim()}`);
      });
    }

    // EXACTLY TWO. Adding a third means `AUTO` starts resolving to MCP for
    // workspaces on the strength of something that is not a Claude tool call —
    // read the file docblock before editing this list, and if the new writer
    // is genuinely a Claude, say why it cannot widen the 14-day window.
    expect(writers.sort()).toEqual(
      [
        'modules/marketing/mcp/mcp-invoker.service.ts :: ' +
          "return await this.runs.track(workspaceId, { agent: 'mcp', goal: toolName, input: args }, async (agentRunId) => {",
        'modules/marketing/mcp/mcp-approval-executor.service.ts :: ' +
          "{ agent: 'mcp', goal: `apply approval ${approvalId}: ${toolName}` },",
      ].sort(),
    );

    // The reads are unconstrained in number — they cannot change who pays —
    // but the classifier has to be shown working on at least one, or a broken
    // regex would report "no writers" and pass vacuously.
    expect(readers).toContain(
      'modules/marketing/research/research-lease.service.ts :: agent: MCP_ACTIVITY_AGENT,',
    );
  });

  /** The value itself, so a rename cannot quietly orphan the list above. */
  it('is the value AUTO actually reads', () => {
    expect(MCP_ACTIVITY_AGENT).toBe('mcp');
  });
});
