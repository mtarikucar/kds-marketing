import type { BuilderState, WorkflowDto, WorkflowTemplate } from './automationTypes';

/** Map a saved workflow (GET /workflows/:id) into builder state. `goal` is left
 *  `undefined` so editing trigger/steps does not clobber the stored goal on a
 *  PATCH (the read-only goal node is shown from the DTO separately). */
export function fromWorkflowDto(dto: WorkflowDto): BuilderState {
  return {
    name: dto.name ?? '',
    triggerType: dto.trigger?.type ?? 'lead.created',
    filters: dto.trigger?.filters ?? [],
    steps: dto.steps ?? [],
    goal: undefined,
  };
}

/** Pre-fill builder state from a starter template. A fresh template workflow
 *  carries its own goal (or null) so Save persists it. */
export function fromTemplate(tpl: WorkflowTemplate): BuilderState {
  return {
    name: tpl.name ?? '',
    triggerType: tpl.trigger?.type ?? 'lead.created',
    filters: tpl.trigger?.filters ?? [],
    steps: tpl.steps ?? [],
    goal: tpl.goal ?? null,
  };
}

/** Build the POST/PATCH body. `goal` is sent only when explicitly set (object)
 *  or cleared (null); `undefined` means leave the stored goal as-is on a PATCH. */
export function toSavePayload(s: BuilderState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: s.name,
    trigger: { type: s.triggerType, filters: s.filters ?? [] },
    steps: s.steps ?? [],
  };
  if (s.goal !== undefined) payload.goal = s.goal;
  return payload;
}
