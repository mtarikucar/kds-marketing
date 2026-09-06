import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * EVERY TOOL THE READINESS LIST NAMES MUST BE ABLE TO CLOSE ITS GAP.
 *
 * `WorkspaceReadinessService` puts an `mcpTool` on each gap, the panel prints a
 * robot beside that row, and the tool description tells an agent to call it. So
 * the field is a promise made to two audiences at once, and a wrong one fails in
 * the worst available way: the agent calls the tool, the tool no-ops or refuses,
 * and the gap survives a fix that reported success.
 *
 * The first version of this list shipped three wrong ones — and none was a typo.
 * Each named a REAL registered tool whose name matched the gap
 * (`synthesize_strategy` for `strategy`, `create_social_campaign` for
 * `active-campaign`, `set_strategy_autonomy` for `autonomy`) and whose contract
 * refused the thing the gap needed. They were written from the catalogue's
 * names instead of its behaviour, which is a mistake a unit test with a mocked
 * Prisma cannot see: nothing in that test ever calls the tool.
 *
 * So this reads the SOURCE of both sides and checks the two halves that are
 * mechanically checkable — the tool exists, and it is not approval-gated. The
 * third half (does calling it actually satisfy this gap's condition?) is a
 * judgement, and it is recorded case by case in the service's own comments.
 */
describe('readiness mcpTool promises', () => {
  const here = __dirname;
  const readinessSrc = readFileSync(join(here, 'workspace-readiness.service.ts'), 'utf8');
  const toolsDir = join(here, '..', 'mcp', 'tools');

  /**
   * Every `jeeta.x` the readiness list promises, from BOTH shapes the field
   * takes: the plain literal, and the state-dependent conditional the `strategy`
   * item needs (see below). The earlier `/mcpTool:\s*'([^']+)'/` saw only the
   * first — so the moment one item's promise became conditional, this file
   * would have stopped checking that promise and still reported success, which
   * is the same class of silent blindness as the guard test above.
   */
  const promised = [...readinessSrc.matchAll(/mcpTool:([^\n]*)/g)].flatMap((m) =>
    [...m[1].matchAll(/'(jeeta\.[a-z_]+)'/g)].map((t) => t[1]),
  );

  /** The subset promised UNCONDITIONALLY — `mcpTool: 'jeeta.x',` and nothing
   *  else on the line. Used to pin the one promise that must not be. */
  const unconditional = [...readinessSrc.matchAll(/mcpTool:\s*'(jeeta\.[a-z_]+)'\s*,/g)].map((m) => m[1]);

  /** name -> requiresApproval, read from each `registry.register({...})` block. */
  const registry = new Map<string, boolean>();
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && !f.includes('.spec.'))) {
    const src = readFileSync(join(toolsDir, f), 'utf8');
    for (const block of src.split('registry.register({').slice(1)) {
      const name = /name:\s*'(jeeta\.[a-z_]+)'/.exec(block)?.[1];
      if (!name) continue;
      registry.set(name, /requiresApproval:\s*true/.test(block.slice(0, block.indexOf('handler:'))));
    }
  }

  it('reads both sides, so a silent parse failure cannot pass this file', () => {
    // Without this, a renamed field or a moved directory turns every assertion
    // below into a loop over nothing — which reports success.
    expect(registry.size).toBeGreaterThan(50);
    expect(promised.length).toBeGreaterThan(3);
  });

  it('names only tools that are actually registered', () => {
    const missing = promised.filter((n) => !registry.has(n));
    expect({ missing }).toEqual({ missing: [] });
  });

  /**
   * A tool may only be promised for the STATES it can serve.
   *
   * `mcpTool` is one field on an item that has three states, so a promise made
   * from a constant is a promise made in all three. `jeeta.submit_strategy`
   * closes the `strategy` gap in the MISSING state and refuses in the other two
   * — it creates the workspace's FIRST strategy and rejects any existing row
   * ("This workspace already has a strategy…", strategy-synthesis.service.ts).
   * On the ATTENTION branch (a row that exists with a non-ACTIVE status) an
   * unconditional promise would send an agent to a tool that cannot help: the
   * robot beside the row, the call, the refusal, the gap still open.
   *
   * Checked here as SHAPE — the promise must not be written as a constant — so
   * that a future edit flattening the conditional fails this file. The three
   * states themselves are asserted against the real service in
   * `workspace-readiness.service.spec.ts`.
   */
  it('promises submit_strategy conditionally, because it refuses two of that item’s three states', () => {
    expect(promised).toContain('jeeta.submit_strategy');
    expect(unconditional).not.toContain('jeeta.submit_strategy');
  });

  it('names no tool that would queue for a human instead of closing the gap', () => {
    // An approval-gated tool cannot close a gap unattended: the call returns
    // when the request is FILED, not when the work is done, so the agent reads
    // success and the item stays exactly as it was. Whatever the panel promises
    // with that robot, it is not "your connected Claude can do this".
    const gated = promised.filter((n) => registry.get(n) === true);
    expect({ gated }).toEqual({ gated: [] });
  });
});
