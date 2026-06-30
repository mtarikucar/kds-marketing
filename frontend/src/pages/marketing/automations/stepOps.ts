import { remapJumpTargets, remapGoalGoto, type AnyStep, type DslGoal } from './workflowGraph';

type Goal = DslGoal | null | undefined;

/** Default config for a freshly-added step, keyed by type. Kept in sync with the
 *  DSL minimums so an appended node always serialises to a valid step. */
export const NEW_STEP: Record<string, AnyStep> = {
  send_email: { type: 'send_email', subject: 'Subject', body: 'Hi {{lead.contactPerson}}' },
  send_sms: { type: 'send_sms', body: 'Hi {{lead.contactPerson}}' },
  send_whatsapp: { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}}' },
  ai_generate: { type: 'ai_generate', prompt: 'Write a friendly opener', saveAs: 'ai_output' },
  ai_classify: { type: 'ai_classify', prompt: 'Classify this lead', categories: ['hot', 'cold'], routes: {} },
  wait: { type: 'wait', mode: 'duration', seconds: 86400 },
  branch: { type: 'branch', filters: [{ field: 'lead.status', op: 'eq', value: 'NEW' }] },
  create_task: { type: 'create_task', title: 'Follow up with {{lead.contactPerson}}', dueInHours: 24 },
  assign_lead: { type: 'assign_lead', strategy: 'auto' },
  update_lead: { type: 'update_lead', set: { status: 'CONTACTED' } },
  notify_user: { type: 'notify_user', message: 'New lead {{lead.businessName}}' },
  http_webhook_out: { type: 'http_webhook_out', url: 'https://', method: 'POST', body: '{}' },
  add_tag: { type: 'add_tag', tag: 'customer' },
  remove_tag: { type: 'remove_tag', tag: 'prospect' },
  send_review_request: { type: 'send_review_request' },
  stop_workflow: { type: 'stop_workflow' },
};

/** Append a default-configured step of `type`. Pure — returns a new array. */
export function appendStep(steps: AnyStep[], type: string): AnyStep[] {
  const template = NEW_STEP[type] ?? { type };
  return [...steps, structuredClone(template)];
}

/** Delete the step at `idx`, remapping every jump target (branch/route/goal) so
 *  surviving jumps keep pointing at the same logical step. */
export function deleteStepAt(steps: AnyStep[], idx: number, goal: Goal): { steps: AnyStep[]; goal: Goal } {
  // targets after the removed step shift down one; a jump AT it is dropped.
  const map = (i: number) => (i === idx ? null : i > idx ? i - 1 : i);
  const remapped = remapJumpTargets(steps, map).filter((_, i) => i !== idx);
  const nextGoal = goal?.onMet === 'goto' ? remapGoalGoto(goal, map) : goal;
  return { steps: remapped, goal: nextGoal };
}

/** Move the step at `idx` by `dir` (−1 up / +1 down), swapping jump targets so
 *  jumps follow the moved steps. No-op at the array edges. */
export function moveStepAt(steps: AnyStep[], idx: number, dir: -1 | 1, goal: Goal): { steps: AnyStep[]; goal: Goal } {
  const j = idx + dir;
  if (j < 0 || j >= steps.length) return { steps, goal };
  const map = (i: number) => (i === idx ? j : i === j ? idx : i);
  const remapped = [...remapJumpTargets(steps, map)];
  [remapped[idx], remapped[j]] = [remapped[j], remapped[idx]];
  const nextGoal = goal?.onMet === 'goto' ? remapGoalGoto(goal, map) : goal;
  return { steps: remapped, goal: nextGoal };
}
