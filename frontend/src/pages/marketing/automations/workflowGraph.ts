/**
 * workflowGraph.ts — pure mapping from the workflow DSL (trigger + ordered
 * steps[] + optional goal) to a React Flow node/edge graph, plus per-step-type
 * presentation metadata. No React here; the canvas component consumes this.
 *
 * Layout is a simple vertical stack (trigger on top, one node per step in
 * order); control-flow that jumps — branch.elseGoto, ai_classify.routes, and a
 * goto goal — render as extra labelled edges between the stacked nodes, so the
 * linear-with-branches GHL feel reads at a glance without a heavyweight layout
 * engine.
 */

export type AnyStep = Record<string, any> & { type: string };
export interface DslGoal {
  filters?: unknown[];
  onMet?: 'exit' | 'goto';
  gotoStep?: number;
}

export interface StepTypeMeta {
  label: string;
  /** lucide-react icon name resolved by the canvas. */
  icon: string;
  /** Tailwind tone class group for the node accent. */
  tone: 'trigger' | 'send' | 'ai' | 'flow' | 'action' | 'stop' | 'goal';
}

export const STEP_META: Record<string, StepTypeMeta> = {
  send_email: { label: 'Send email', icon: 'Mail', tone: 'send' },
  send_sms: { label: 'Send SMS', icon: 'MessageSquare', tone: 'send' },
  send_whatsapp: { label: 'Send WhatsApp', icon: 'MessageCircle', tone: 'send' },
  send_webchat: { label: 'Send web chat', icon: 'MessageSquare', tone: 'send' },
  ai_generate: { label: 'AI generate', icon: 'Sparkles', tone: 'ai' },
  ai_classify: { label: 'AI classify', icon: 'GitBranch', tone: 'ai' },
  branch: { label: 'If / branch', icon: 'GitBranch', tone: 'flow' },
  wait: { label: 'Wait', icon: 'Clock', tone: 'flow' },
  create_task: { label: 'Create task', icon: 'CheckSquare', tone: 'action' },
  assign_lead: { label: 'Assign lead', icon: 'UserPlus', tone: 'action' },
  update_lead: { label: 'Update lead', icon: 'PencilLine', tone: 'action' },
  notify_user: { label: 'Notify user', icon: 'Bell', tone: 'action' },
  http_webhook_out: { label: 'Webhook out', icon: 'Webhook', tone: 'action' },
  start_workflow: { label: 'Start workflow', icon: 'Play', tone: 'flow' },
  stop_workflow: { label: 'Stop', icon: 'StopCircle', tone: 'stop' },
  send_review_request: { label: 'Review request', icon: 'Star', tone: 'action' },
  add_tag: { label: 'Add tag', icon: 'Tag', tone: 'action' },
  remove_tag: { label: 'Remove tag', icon: 'Tag', tone: 'action' },
};

export function stepMeta(type: string): StepTypeMeta {
  return STEP_META[type] ?? { label: type, icon: 'Box', tone: 'action' };
}

/** A one-line human summary of a step's key config, for the node body. */
export function stepSummary(step: AnyStep): string {
  switch (step.type) {
    case 'send_email':
      return step.subject ? `“${truncate(step.subject, 40)}”` : truncate(step.body ?? '', 48);
    case 'send_sms':
    case 'send_whatsapp':
    case 'send_webchat':
      return truncate(step.body ?? '', 48);
    case 'wait':
      return step.mode === 'until_reply' ? 'until reply' : humanDuration(step.seconds);
    case 'branch':
      return `${(step.filters ?? []).length} condition(s)`;
    case 'ai_generate':
      return truncate(step.prompt ?? '', 48);
    case 'ai_classify':
      return (step.categories ?? []).join(' · ');
    case 'create_task':
      return truncate(step.title ?? '', 48);
    case 'notify_user':
      return truncate(step.message ?? '', 48);
    case 'add_tag':
    case 'remove_tag':
      return step.tag ?? '';
    case 'assign_lead':
      return step.strategy ?? 'auto';
    case 'update_lead':
      return Object.keys(step.set ?? {}).join(', ');
    case 'start_workflow':
      return step.workflowId ?? '';
    case 'http_webhook_out':
      return truncate(step.url ?? '', 48);
    default:
      return '';
  }
}

export interface GraphNode {
  id: string;
  type: 'wfNode';
  position: { x: number; y: number };
  data: {
    kind: 'trigger' | 'step' | 'goal';
    stepIndex?: number;
    title: string;
    summary: string;
    icon: string;
    tone: StepTypeMeta['tone'];
  };
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
  /** dashed = a jump (branch else / route / goal), solid = sequential fall-through. */
  dashed?: boolean;
}

const NODE_X = 60;
const NODE_DY = 130;

/** Build the node/edge graph. Node ids: 'trigger', 'step-<i>', 'goal'. */
export function buildWorkflowGraph(
  triggerType: string,
  steps: AnyStep[],
  goal?: DslGoal | null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  nodes.push({
    id: 'trigger',
    type: 'wfNode',
    position: { x: NODE_X, y: 0 },
    data: { kind: 'trigger', title: triggerType, summary: 'Trigger', icon: 'Zap', tone: 'trigger' },
  });

  steps.forEach((rawStep, i) => {
    // parsedSteps is arbitrary user JSON; a null / non-object element would throw
    // on `.type`. Coerce it to an unknown step so the canvas renders (and the
    // backend rejects it cleanly on save) instead of crashing the dialog.
    const step: AnyStep = rawStep && typeof rawStep === 'object' ? rawStep : { type: '' };
    const meta = stepMeta(step.type);
    nodes.push({
      id: `step-${i}`,
      type: 'wfNode',
      position: { x: NODE_X, y: (i + 1) * NODE_DY },
      data: { kind: 'step', stepIndex: i, title: meta.label, summary: stepSummary(step), icon: meta.icon, tone: meta.tone },
    });
  });

  // Sequential fall-through edges (trigger → 0 → 1 → …). No synthetic "end"
  // node: the last step (and stop_workflow) simply has no outgoing edge.
  if (steps.length) edges.push(seq('trigger', 'step-0'));
  steps.forEach((rawStep, i) => {
    const step: AnyStep = rawStep && typeof rawStep === 'object' ? rawStep : { type: '' };
    const hasNext = i + 1 < steps.length;
    // stop_workflow terminates, so it draws no fall-through edge.
    if (step.type !== 'stop_workflow' && hasNext) {
      edges.push(seq(`step-${i}`, `step-${i + 1}`));
    }
    if (step.type === 'branch' && typeof step.elseGoto === 'number' && step.elseGoto < steps.length) {
      edges.push(jump(`step-${i}`, `step-${step.elseGoto}`, 'else'));
    }
    if (step.type === 'ai_classify' && step.routes && typeof step.routes === 'object') {
      for (const [cat, idx] of Object.entries(step.routes as Record<string, number>)) {
        if (typeof idx === 'number' && idx < steps.length) edges.push(jump(`step-${i}`, `step-${idx}`, cat));
      }
    }
  });

  // Goal: a terminal/jump indicator node.
  if (goal && (goal.onMet === 'exit' || goal.onMet === 'goto')) {
    nodes.push({
      id: 'goal',
      type: 'wfNode',
      position: { x: NODE_X + 320, y: NODE_DY },
      data: {
        kind: 'goal',
        // 1-based to match the step-node labels (which render index + 1).
        title: goal.onMet === 'goto' ? `Goal → step ${(goal.gotoStep ?? 0) + 1}` : 'Goal → exit',
        summary: `${(goal.filters ?? []).length} condition(s)`,
        icon: 'Target',
        tone: 'goal',
      },
    });
    if (goal.onMet === 'goto' && typeof goal.gotoStep === 'number' && goal.gotoStep < steps.length) {
      edges.push(jump('goal', `step-${goal.gotoStep}`, 'on met'));
    }
  }

  return { nodes, edges };
}

/**
 * Rewrite the numeric jump targets inside a step list (branch.elseGoto and
 * ai_classify.routes values) through a remap function. Used by the canvas after
 * a reorder/delete so jumps keep pointing at the SAME logical step rather than
 * silently re-targeting. `remap(oldIndex)` returns the new index, or null to
 * drop that jump (e.g. its target step was deleted). Pure — returns a new array.
 */
export function remapJumpTargets(steps: AnyStep[], remap: (i: number) => number | null): AnyStep[] {
  return steps.map((s) => {
    if (s.type === 'branch' && typeof s.elseGoto === 'number') {
      const m = remap(s.elseGoto);
      if (m == null) {
        const { elseGoto, ...rest } = s;
        return rest;
      }
      return { ...s, elseGoto: m };
    }
    if (s.type === 'ai_classify' && s.routes && typeof s.routes === 'object') {
      const routes: Record<string, number> = {};
      for (const [k, v] of Object.entries(s.routes as Record<string, number>)) {
        if (typeof v !== 'number') continue;
        const m = remap(v);
        if (m != null) routes[k] = m;
      }
      return { ...s, routes };
    }
    return s;
  });
}

/**
 * Remap a goto goal's gotoStep through the SAME index map the canvas uses for
 * branch/route jumps, so a reorder/delete keeps the goal pointing at the same
 * logical step instead of silently re-targeting (or 400-ing the save). If the
 * goal's target step was deleted (remap → null) the goto is dropped and the goal
 * falls back to onMet:'exit'. Non-goto goals are returned unchanged (same ref).
 */
export function remapGoalGoto(goal: DslGoal | null | undefined, remap: (i: number) => number | null): DslGoal | null | undefined {
  if (!goal || goal.onMet !== 'goto' || typeof goal.gotoStep !== 'number') return goal;
  const m = remap(goal.gotoStep);
  if (m == null) {
    const { gotoStep, ...rest } = goal;
    return { ...rest, onMet: 'exit' };
  }
  return { ...goal, gotoStep: m };
}

function seq(source: string, target: string): GraphEdge {
  return { id: `e-${source}-${target}`, source, target, dashed: false };
}
function jump(source: string, target: string, label: string): GraphEdge {
  return { id: `j-${source}-${target}-${label}`, source, target, label, dashed: true, animated: true };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function humanDuration(seconds?: number): string {
  if (!seconds) return '—';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
