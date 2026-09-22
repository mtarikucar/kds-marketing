import { normalizeSendWindow } from '../channels/outbound/mail-window';
import { parseWorkflowParts, WorkflowDslSchema } from './workflow-dsl.schema';

/**
 * DSL validation is the guardrail between user/AI input and the executor: a
 * malformed automation must be a 400, never a stored row the executor chokes
 * on. These pin the accept/reject boundary.
 */
describe('workflow DSL', () => {
  const okTrigger = { type: 'lead.created', filters: [] };
  const okSteps = [
    { type: 'wait', mode: 'duration', seconds: 3600 },
    { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}}' },
    { type: 'stop_workflow' },
  ];

  it('accepts a well-formed automation', () => {
    const dsl = parseWorkflowParts(okTrigger, okSteps);
    expect(dsl.steps).toHaveLength(3);
    expect(dsl.trigger.type).toBe('lead.created');
  });

  it('rejects an unknown trigger type', () => {
    expect(() => parseWorkflowParts({ type: 'lead.exploded', filters: [] }, okSteps)).toThrow();
  });

  it('accepts the opportunity + tag triggers and tag actions (GHL parity)', () => {
    const dsl = parseWorkflowParts(
      { type: 'opportunity.stage_changed', filters: [{ field: 'trigger.status', op: 'eq', value: 'WON' }] },
      [
        { type: 'add_tag', tag: 'customer' },
        { type: 'remove_tag', tag: 'prospect' },
        { type: 'stop_workflow' },
      ],
    );
    expect(dsl.trigger.type).toBe('opportunity.stage_changed');
    expect(dsl.steps[0]).toMatchObject({ type: 'add_tag', tag: 'customer' });
    expect(parseWorkflowParts({ type: 'tag.added', filters: [] }, okSteps).trigger.type).toBe('tag.added');
  });

  it('rejects an empty tag on add_tag', () => {
    expect(() => parseWorkflowParts(okTrigger, [{ type: 'add_tag', tag: '' }])).toThrow();
  });

  it('rejects an unknown step type', () => {
    expect(() => parseWorkflowParts(okTrigger, [{ type: 'launch_missiles' }])).toThrow();
  });

  it('rejects a filter field outside the lead/trigger/context whitelist', () => {
    expect(() =>
      parseWorkflowParts(
        { type: 'lead.created', filters: [{ field: 'process.env.SECRET', op: 'eq', value: 'x' }] },
        okSteps,
      ),
    ).toThrow();
  });

  it('enforces the 100-step cap', () => {
    const steps = Array.from({ length: 101 }, () => ({ type: 'stop_workflow' }));
    expect(() => parseWorkflowParts(okTrigger, steps)).toThrow();
  });

  it('requires a non-empty step list', () => {
    expect(() => parseWorkflowParts(okTrigger, [])).toThrow();
  });

  it('defaults trigger.filters to [] when omitted', () => {
    const dsl = WorkflowDslSchema.parse({ trigger: { type: 'task.completed' }, steps: okSteps });
    expect(dsl.trigger.filters).toEqual([]);
  });

  describe('wait step', () => {
    it('rejects a duration wait with no seconds (executor would silently default to 1h)', () => {
      expect(() =>
        parseWorkflowParts(okTrigger, [
          { type: 'wait', mode: 'duration' },
          { type: 'stop_workflow' },
        ]),
      ).toThrow();
    });

    it('accepts an until_reply wait with no explicit seconds (its cap is optional)', () => {
      expect(() =>
        parseWorkflowParts(okTrigger, [
          { type: 'wait', mode: 'until_reply' },
          { type: 'stop_workflow' },
        ]),
      ).not.toThrow();
    });
  });

  describe('ai_classify routes', () => {
    const classifyAt = (routes: Record<string, number>) => [
      {
        type: 'ai_classify',
        prompt: 'classify',
        categories: ['hot', 'cold'],
        routes,
      },
      { type: 'stop_workflow' },
    ];

    it('accepts routes whose keys are declared categories and targets are in-bounds', () => {
      expect(() => parseWorkflowParts(okTrigger, classifyAt({ hot: 1 }))).not.toThrow();
    });

    it('rejects a route key that is not a declared category', () => {
      expect(() => parseWorkflowParts(okTrigger, classifyAt({ lukewarm: 1 }))).toThrow();
    });

    it('rejects a route target that overruns steps.length', () => {
      // 2 steps → valid indexes are 0,1; 5 is out of bounds.
      expect(() => parseWorkflowParts(okTrigger, classifyAt({ hot: 5 }))).toThrow();
    });
  });

  describe('branch.elseGoto bounds', () => {
    const branchAt = (elseGoto: number) => [
      { type: 'branch', filters: [{ field: 'lead.status', op: 'eq', value: 'NEW' }], elseGoto },
      { type: 'send_whatsapp', body: 'hi' },
      { type: 'stop_workflow' },
    ];

    it('accepts an in-bounds elseGoto', () => {
      expect(() => parseWorkflowParts(okTrigger, branchAt(2))).not.toThrow();
    });

    it('rejects an elseGoto that overruns steps.length (would silently end the run)', () => {
      // 3 steps → valid indexes 0,1,2; 9 is out of bounds.
      expect(() => parseWorkflowParts(okTrigger, branchAt(9))).toThrow();
    });
  });

  describe('goal (GHL parity)', () => {
    const goalFilters = [{ field: 'lead.status', op: 'eq', value: 'customer' }];

    it('accepts an exit goal and defaults onMet to "exit"', () => {
      const dsl = parseWorkflowParts(okTrigger, okSteps, { filters: goalFilters });
      expect(dsl.goal).toMatchObject({ onMet: 'exit' });
      expect(dsl.goal?.filters).toHaveLength(1);
    });

    it('accepts a goto goal with an in-bounds target', () => {
      const dsl = parseWorkflowParts(okTrigger, okSteps, { filters: goalFilters, onMet: 'goto', gotoStep: 1 });
      expect(dsl.goal).toMatchObject({ onMet: 'goto', gotoStep: 1 });
    });

    it('rejects a goto goal missing gotoStep', () => {
      expect(() => parseWorkflowParts(okTrigger, okSteps, { filters: goalFilters, onMet: 'goto' })).toThrow();
    });

    it('rejects a goto target that overruns steps.length', () => {
      // okSteps has 3 steps → valid indexes 0,1,2; 9 is out of bounds.
      expect(() => parseWorkflowParts(okTrigger, okSteps, { filters: goalFilters, onMet: 'goto', gotoStep: 9 })).toThrow();
    });

    it('rejects an empty goal filter set (a goal with no condition never fires)', () => {
      expect(() => parseWorkflowParts(okTrigger, okSteps, { filters: [], onMet: 'exit' })).toThrow();
    });

    it('rejects a goal filter field outside the whitelist', () => {
      expect(() =>
        parseWorkflowParts(okTrigger, okSteps, { filters: [{ field: 'process.env.X', op: 'eq', value: '1' }] }),
      ).toThrow();
    });

    it('leaves goal undefined when not supplied', () => {
      expect(parseWorkflowParts(okTrigger, okSteps).goal).toBeUndefined();
    });
  });

  describe('trigger.sendWindow (per-workflow quiet hours)', () => {
    const window = { tz: 'Europe/Istanbul', from: 9, to: 21 };

    it('accepts a window and keeps it on the parsed trigger', () => {
      // The parsed trigger is what workflows.service persists, so a key the
      // schema does not declare is stripped on save and the window would
      // silently vanish between the form and the executor.
      const dsl = parseWorkflowParts({ ...okTrigger, sendWindow: window }, okSteps);
      expect(dsl.trigger.sendWindow).toEqual(window);
    });

    it('accepts a window that wraps midnight', () => {
      const dsl = parseWorkflowParts({ ...okTrigger, sendWindow: { tz: 'Europe/Istanbul', from: 22, to: 6 } }, okSteps);
      expect(dsl.trigger.sendWindow).toMatchObject({ from: 22, to: 6 });
    });

    it('accepts a window with no tz (the workspace timezone answers)', () => {
      const dsl = parseWorkflowParts({ ...okTrigger, sendWindow: { from: 9, to: 21 } }, okSteps);
      expect(dsl.trigger.sendWindow).toEqual({ from: 9, to: 21 });
    });

    it('leaves sendWindow undefined when not supplied (every existing workflow)', () => {
      expect(parseWorkflowParts(okTrigger, okSteps).trigger.sendWindow).toBeUndefined();
    });

    it('rejects hours that describe nothing', () => {
      // from === to is either "always" or "never" and there is no way to tell
      // which was meant — better a 400 at save time than a guess at 02:30.
      expect(() => parseWorkflowParts({ ...okTrigger, sendWindow: { from: 9, to: 9 } }, okSteps)).toThrow();
      expect(() => parseWorkflowParts({ ...okTrigger, sendWindow: { from: -1, to: 21 } }, okSteps)).toThrow();
      expect(() => parseWorkflowParts({ ...okTrigger, sendWindow: { from: 9, to: 25 } }, okSteps)).toThrow();
      expect(() => parseWorkflowParts({ ...okTrigger, sendWindow: { from: 9.5, to: 21 } }, okSteps)).toThrow();
      expect(() => parseWorkflowParts({ ...okTrigger, sendWindow: { from: 9 } }, okSteps)).toThrow();
    });
  });
});

/**
 * The DSL and the clamp must agree on the shape, or a window saved through the
 * API is one the sender cannot read.
 */
describe('trigger.sendWindow feeds the clamp unchanged', () => {
  it('parses back out of the DSL into a usable SendWindow', () => {
    const dsl = parseWorkflowParts(
      { type: 'lead.created', filters: [], sendWindow: { tz: 'Europe/Istanbul', from: 9, to: 21 } },
      [{ type: 'send_email', body: 'hi' }],
    );
    expect(normalizeSendWindow(dsl.trigger.sendWindow, null)).toEqual({
      tz: 'Europe/Istanbul',
      from: 9,
      to: 21,
    });
  });

  it('a tz-less window is resolved against the workspace timezone', () => {
    const dsl = parseWorkflowParts(
      { type: 'lead.created', filters: [], sendWindow: { from: 9, to: 21 } },
      [{ type: 'send_email', body: 'hi' }],
    );
    expect(normalizeSendWindow(dsl.trigger.sendWindow, 'Europe/Istanbul')).toEqual({
      tz: 'Europe/Istanbul',
      from: 9,
      to: 21,
    });
  });
});
