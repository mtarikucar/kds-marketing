import { describe, it, expect } from 'vitest';
import { buildWorkflowGraph, remapJumpTargets, remapGoalGoto, stepSummary, stepMeta } from './workflowGraph';

describe('buildWorkflowGraph', () => {
  it('renders a trigger node + one node per step, chained sequentially', () => {
    const { nodes, edges } = buildWorkflowGraph('lead.created', [
      { type: 'send_email', subject: 'Hi', body: 'x' },
      { type: 'wait', mode: 'duration', seconds: 3600 },
    ]);
    expect(nodes.map((n) => n.id)).toEqual(['trigger', 'step-0', 'step-1']);
    // trigger→0→1 fall-through.
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'trigger', target: 'step-0', dashed: false }),
      expect.objectContaining({ source: 'step-0', target: 'step-1', dashed: false }),
    ]));
  });

  it('draws a dashed else edge for a branch.elseGoto', () => {
    const { edges } = buildWorkflowGraph('lead.created', [
      { type: 'branch', filters: [], elseGoto: 2 },
      { type: 'stop_workflow' },
      { type: 'notify_user', message: 'm' },
    ]);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'step-0', target: 'step-2', label: 'else', dashed: true }),
    ]));
  });

  it('draws labelled route edges for ai_classify', () => {
    const { edges } = buildWorkflowGraph('lead.created', [
      { type: 'ai_classify', prompt: 'p', categories: ['hot', 'cold'], routes: { hot: 1 } },
      { type: 'notify_user', message: 'm' },
    ]);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'step-0', target: 'step-1', label: 'hot', dashed: true }),
    ]));
  });

  it('stop_workflow has no outgoing fall-through edge', () => {
    const { edges } = buildWorkflowGraph('lead.created', [
      { type: 'stop_workflow' },
      { type: 'notify_user', message: 'm' },
    ]);
    expect(edges.some((e) => e.source === 'step-0')).toBe(false);
  });

  it('adds a goal node and links a goto goal to its target', () => {
    const { nodes, edges } = buildWorkflowGraph(
      'lead.created',
      [{ type: 'notify_user', message: 'a' }, { type: 'notify_user', message: 'b' }],
      { onMet: 'goto', gotoStep: 1, filters: [{}] },
    );
    expect(nodes.some((n) => n.id === 'goal')).toBe(true);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'goal', target: 'step-1', dashed: true }),
    ]));
  });

  it('drops out-of-bounds jump targets (no edge to a nonexistent node)', () => {
    const { edges } = buildWorkflowGraph('lead.created', [
      { type: 'branch', filters: [], elseGoto: 9 },
    ]);
    expect(edges.some((e) => e.target === 'step-9')).toBe(false);
  });

  it('handles an empty step list without a dangling edge', () => {
    const { nodes, edges } = buildWorkflowGraph('lead.created', []);
    expect(nodes.map((n) => n.id)).toEqual(['trigger']);
    expect(edges).toHaveLength(0);
  });
});

describe('remapJumpTargets (reorder/delete index safety)', () => {
  // delete index 1: targets after it shift down one; a jump AT it is dropped.
  const deleteMap = (idx: number) => (i: number) => (i === idx ? null : i > idx ? i - 1 : i);

  it('shifts a branch.elseGoto down when an earlier step is deleted', () => {
    const steps = [
      { type: 'branch', filters: [], elseGoto: 3 },
      { type: 'notify_user', message: 'x' },
      { type: 'notify_user', message: 'y' },
      { type: 'stop_workflow' },
    ];
    const out = remapJumpTargets(steps, deleteMap(1));
    expect(out[0]).toMatchObject({ elseGoto: 2 }); // 3 → 2
  });

  it('drops a branch.elseGoto that pointed at the deleted step', () => {
    const steps = [{ type: 'branch', filters: [], elseGoto: 1 }, { type: 'stop_workflow' }];
    const out = remapJumpTargets(steps, deleteMap(1));
    expect('elseGoto' in out[0]).toBe(false);
  });

  it('remaps ai_classify routes and drops a route to the deleted step', () => {
    const steps = [
      { type: 'ai_classify', prompt: 'p', categories: ['a', 'b'], routes: { a: 1, b: 3 } },
      { type: 'notify_user', message: 'x' },
      { type: 'notify_user', message: 'y' },
      { type: 'stop_workflow' },
    ];
    const out: any = remapJumpTargets(steps, deleteMap(1));
    expect(out[0].routes).toEqual({ b: 2 }); // a→1 dropped (deleted), b:3→2
  });

  it('swaps two indices in jump targets on a reorder', () => {
    const steps = [
      { type: 'branch', filters: [], elseGoto: 2 },
      { type: 'notify_user', message: 'x' },
      { type: 'stop_workflow' },
    ];
    // swap 0 and 1
    const out = remapJumpTargets(steps, (i) => (i === 0 ? 1 : i === 1 ? 0 : i));
    expect(out[0]).toMatchObject({ elseGoto: 2 }); // 2 unaffected
  });

  it('leaves non-jump steps untouched', () => {
    const steps = [{ type: 'send_sms', body: 'hi' }];
    expect(remapJumpTargets(steps, deleteMap(5))).toEqual(steps);
  });
});

describe('remapGoalGoto (goal index safety)', () => {
  const deleteMap = (idx: number) => (i: number) => (i === idx ? null : i > idx ? i - 1 : i);

  it('shifts a goto goal down when an earlier step is deleted', () => {
    expect(remapGoalGoto({ onMet: 'goto', gotoStep: 3, filters: [{}] }, deleteMap(1)))
      .toMatchObject({ onMet: 'goto', gotoStep: 2 });
  });

  it('drops the goto (falls back to exit) when the goal target step is deleted', () => {
    const out = remapGoalGoto({ onMet: 'goto', gotoStep: 2, filters: [{}] }, deleteMap(2)) as any;
    expect(out.onMet).toBe('exit');
    expect('gotoStep' in out).toBe(false);
  });

  it('swaps the goto index on a reorder', () => {
    const out = remapGoalGoto({ onMet: 'goto', gotoStep: 0, filters: [{}] }, (i) => (i === 0 ? 1 : i === 1 ? 0 : i)) as any;
    expect(out.gotoStep).toBe(1);
  });

  it('leaves an exit goal untouched (same reference)', () => {
    const exit = { onMet: 'exit' as const, filters: [{}] };
    expect(remapGoalGoto(exit, deleteMap(0))).toBe(exit);
  });

  it('passes through null/undefined', () => {
    expect(remapGoalGoto(null, deleteMap(0))).toBeNull();
    expect(remapGoalGoto(undefined, deleteMap(0))).toBeUndefined();
  });
});

describe('build graph is crash-safe on malformed step elements', () => {
  it('does not throw on a null step element', () => {
    expect(() => buildWorkflowGraph('lead.created', [null as any, { type: 'send_sms', body: 'x' }])).not.toThrow();
  });
});

describe('stepSummary / stepMeta', () => {
  it('summarises common steps', () => {
    expect(stepSummary({ type: 'wait', mode: 'duration', seconds: 86400 })).toBe('1d');
    expect(stepSummary({ type: 'add_tag', tag: 'vip' })).toBe('vip');
    expect(stepMeta('send_email').tone).toBe('send');
    expect(stepMeta('unknown_type').label).toBe('unknown_type');
  });
});
