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
});
