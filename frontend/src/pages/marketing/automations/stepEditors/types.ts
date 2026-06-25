import type { AnyStep } from '../workflowGraph';

/** Common props every per-type step editor receives from StepPropertyPanel. */
export interface StepEditorProps {
  step: AnyStep;
  onPatch: (patch: Record<string, unknown>) => void;
  /** Total step count — used by editors that reference a target step index. */
  count?: number;
}
