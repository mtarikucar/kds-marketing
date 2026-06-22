import { WORKFLOW_TEMPLATES, listWorkflowTemplates } from './workflow-templates';
import { parseWorkflowParts } from './workflow-dsl.schema';

/**
 * The template catalog is a starter-recipe library the UI pre-fills into the
 * create form. A malformed recipe would 400 the moment a user tried to save it,
 * so every entry MUST parse cleanly against the same Zod DSL the API enforces.
 */
describe('workflow templates', () => {
  it('exposes a non-empty catalog', () => {
    expect(listWorkflowTemplates().length).toBeGreaterThan(0);
  });

  it('uses unique template keys', () => {
    const keys = WORKFLOW_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(WORKFLOW_TEMPLATES.map((t) => [t.key, t] as const))(
    'template "%s" is a valid, saveable DSL definition',
    (_key, tpl) => {
      const dsl = parseWorkflowParts(tpl.trigger, tpl.steps, tpl.goal);
      expect(dsl.trigger.type).toBe(tpl.trigger.type);
      expect(dsl.steps.length).toBe(tpl.steps.length);
      // A goto goal (if any) must point inside the step list.
      if (dsl.goal?.onMet === 'goto') {
        expect(dsl.goal.gotoStep).toBeLessThan(dsl.steps.length);
      }
    },
  );

  it('every template has a name, description and category', () => {
    for (const t of WORKFLOW_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.category).toBeTruthy();
    }
  });
});
