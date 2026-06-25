import type { AnyStep, DslGoal } from './workflowGraph';

export interface WorkflowRow {
  id: string;
  name: string;
  status: string; // ACTIVE | PAUSED | DRAFT
  trigger?: { type?: string };
  version: number;
  stats?: { started?: number; completed?: number } | null;
}

export interface WorkflowDto extends WorkflowRow {
  trigger?: { type?: string; filters?: unknown[] };
  steps?: AnyStep[];
  goal?: DslGoal | null;
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  trigger: { type: string; filters?: unknown[] };
  steps: AnyStep[];
  goal?: DslGoal | null;
}

export interface BuilderState {
  name: string;
  triggerType: string;
  filters: unknown[];
  steps: AnyStep[];
  // goal threading: undefined = leave the stored goal as-is on a PATCH;
  // null = no goal (clear); object = set it.
  goal: DslGoal | null | undefined;
}

export const DEFAULT_BUILDER_STATE: BuilderState = {
  name: '',
  triggerType: 'lead.created',
  filters: [],
  steps: [],
  goal: null,
};
