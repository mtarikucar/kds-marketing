import { memo, useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Zap, Mail, MessageSquare, MessageCircle, Sparkles, GitBranch, Clock,
  CheckSquare, UserPlus, PencilLine, Bell, Webhook, Play, StopCircle, Star,
  Tag, Target, Box, Plus, Trash2, ArrowUp, ArrowDown, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import {
  buildWorkflowGraph, remapJumpTargets, remapGoalGoto, STEP_META, stepMeta, type AnyStep, type DslGoal,
} from './workflowGraph';

const ICONS: Record<string, typeof Zap> = {
  Zap, Mail, MessageSquare, MessageCircle, Sparkles, GitBranch, Clock,
  CheckSquare, UserPlus, PencilLine, Bell, Webhook, Play, StopCircle, Star, Tag, Target, Box,
};

const TONE_CLASS: Record<string, string> = {
  trigger: 'border-primary bg-primary-subtle',
  send: 'border-sky-400 bg-sky-50 dark:bg-sky-950/30',
  ai: 'border-violet-400 bg-violet-50 dark:bg-violet-950/30',
  flow: 'border-amber-400 bg-amber-50 dark:bg-amber-950/30',
  action: 'border-border bg-surface',
  stop: 'border-danger bg-danger-subtle',
  goal: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30',
};

/** Default config for a freshly-added step, keyed by type. Kept in sync with the
 *  DSL minimums so an appended node always serialises to a valid step. */
const NEW_STEP: Record<string, AnyStep> = {
  send_email: { type: 'send_email', subject: 'Subject', body: 'Hi {{lead.contactPerson}}' },
  send_sms: { type: 'send_sms', body: 'Hi {{lead.contactPerson}}' },
  send_whatsapp: { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}}' },
  ai_generate: { type: 'ai_generate', prompt: 'Write a friendly opener', saveAs: 'ai_output' },
  wait: { type: 'wait', mode: 'duration', seconds: 86400 },
  branch: { type: 'branch', filters: [{ field: 'lead.status', op: 'eq', value: 'NEW' }] },
  create_task: { type: 'create_task', title: 'Follow up with {{lead.contactPerson}}', dueInHours: 24 },
  assign_lead: { type: 'assign_lead', strategy: 'auto' },
  update_lead: { type: 'update_lead', set: { status: 'CONTACTED' } },
  notify_user: { type: 'notify_user', message: 'New lead {{lead.businessName}}' },
  add_tag: { type: 'add_tag', tag: 'customer' },
  remove_tag: { type: 'remove_tag', tag: 'prospect' },
  send_review_request: { type: 'send_review_request' },
  stop_workflow: { type: 'stop_workflow' },
};

interface WfNodeData {
  kind: 'trigger' | 'step' | 'goal';
  stepIndex?: number;
  title: string;
  summary: string;
  icon: string;
  tone: string;
  // React Flow's Node<T> requires T extends Record<string, unknown>.
  [key: string]: unknown;
}

const WfNode = memo(({ data, selected }: NodeProps<Node<WfNodeData>>) => {
  const Icon = ICONS[data.icon] ?? Box;
  return (
    <div
      className={`rounded-lg border-2 px-3 py-2 shadow-sm w-56 ${TONE_CLASS[data.tone] ?? TONE_CLASS.action} ${selected ? 'ring-2 ring-primary ring-offset-1' : ''}`}
    >
      {data.kind !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-xs font-semibold truncate">
          {data.kind === 'step' ? `${(data.stepIndex ?? 0) + 1}. ` : ''}{data.title}
        </span>
      </div>
      {data.summary && <p className="text-[10px] text-muted-foreground mt-1 truncate">{data.summary}</p>}
      {data.kind !== 'goal' && <Handle type="source" position={Position.Bottom} />}
    </div>
  );
});
WfNode.displayName = 'WfNode';

const nodeTypes = { wfNode: WfNode };

export interface WorkflowCanvasProps {
  triggerType: string;
  steps: AnyStep[];
  goal?: DslGoal | null;
  onStepsChange: (next: AnyStep[]) => void;
  /** Called when a reorder/delete rewrites a goto-goal's gotoStep so the parent
   *  persists the corrected goal instead of a stale index. */
  onGoalChange?: (goal: DslGoal | null | undefined) => void;
}

export function WorkflowCanvas({ triggerType, steps, goal, onStepsChange, onGoalChange }: WorkflowCanvasProps) {
  const { t } = useTranslation('marketing');
  const [selected, setSelected] = useState<number | null>(null);

  const { nodes, edges } = useMemo(() => {
    const g = buildWorkflowGraph(triggerType, steps, goal);
    const rfNodes: Node<WfNodeData>[] = g.nodes.map((n) => ({
      id: n.id, type: n.type, position: n.position, data: n.data as WfNodeData,
      selected: n.data.kind === 'step' && n.data.stepIndex === selected,
    }));
    const rfEdges: Edge[] = g.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.label,
      animated: e.animated, style: e.dashed ? { strokeDasharray: '5 5' } : undefined,
    }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [triggerType, steps, goal, selected]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const idx = (node.data as WfNodeData)?.stepIndex;
    setSelected(typeof idx === 'number' ? idx : null);
  }, []);

  const addStep = (type: string) => {
    const next = [...steps, structuredClone(NEW_STEP[type])];
    onStepsChange(next);
    setSelected(next.length - 1);
  };

  const patchStep = (idx: number, patch: Record<string, unknown>) => {
    const next = steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onStepsChange(next);
  };
  // Apply an index remap to BOTH the step jump targets (branch.elseGoto /
  // ai_classify.routes) and a goto-goal's gotoStep, so a reorder/delete keeps
  // every jump pointing at the same logical step instead of silently
  // re-targeting (or 400-ing the save on an out-of-bounds index).
  const remapGoalIfGoto = (map: (i: number) => number | null) => {
    if (goal?.onMet === 'goto') onGoalChange?.(remapGoalGoto(goal, map));
  };
  const deleteStep = (idx: number) => {
    // targets after the removed step shift down one; a jump AT it is dropped.
    const map = (i: number) => (i === idx ? null : i > idx ? i - 1 : i);
    const remapped = remapJumpTargets(steps, map);
    onStepsChange(remapped.filter((_, i) => i !== idx));
    remapGoalIfGoto(map);
    setSelected(null);
  };
  const moveStep = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= steps.length) return;
    // swap the two indices in every jump target, then swap the array elements.
    const map = (i: number) => (i === idx ? j : i === j ? idx : i);
    const remapped = remapJumpTargets(steps, map);
    const next = [...remapped];
    [next[idx], next[j]] = [next[j], next[idx]];
    onStepsChange(next);
    remapGoalIfGoto(map);
    setSelected(j);
  };

  return (
    <div className="flex gap-3 h-[60vh]">
      <div className="flex-1 rounded-lg border border-border overflow-hidden relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelected(null)}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable={false}
          edgesFocusable={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        {/* Add-step palette */}
        <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-1 max-w-[70%]">
          {Object.keys(NEW_STEP).map((type) => {
            const Icon = ICONS[stepMeta(type).icon] ?? Box;
            return (
              <button
                key={type}
                type="button"
                onClick={() => addStep(type)}
                title={`+ ${STEP_META[type]?.label ?? type}`}
                className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface/90 backdrop-blur text-muted-foreground hover:bg-surface-muted flex items-center gap-0.5"
              >
                <Plus className="h-3 w-3" /><Icon className="h-3 w-3" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Property panel */}
      <div className="w-72 shrink-0 rounded-lg border border-border p-3 overflow-y-auto">
        {selected == null || !steps[selected] ? (
          <p className="text-caption text-muted-foreground">
            {t('automations.canvasHint', 'Click a step to edit it, or use the palette to add one.')}
          </p>
        ) : (
          <StepEditor
            key={selected}
            index={selected}
            step={steps[selected]}
            count={steps.length}
            onPatch={(p) => patchStep(selected, p)}
            onDelete={() => deleteStep(selected)}
            onMove={(d) => moveStep(selected, d)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

interface StepEditorProps {
  index: number;
  step: AnyStep;
  count: number;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onClose: () => void;
}

function StepEditor({ index, step, count, onPatch, onDelete, onMove, onClose }: StepEditorProps) {
  const { t } = useTranslation('marketing');
  const meta = stepMeta(step.type);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{index + 1}. {meta.label}</span>
        <IconButton variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      {(step.type === 'send_email') && (
        <Labeled label={t('automations.subject', 'Subject')}>
          <Input value={step.subject ?? ''} onChange={(e) => onPatch({ subject: e.target.value })} />
        </Labeled>
      )}
      {(step.type === 'send_email' || step.type === 'send_sms' || step.type === 'send_whatsapp' || step.type === 'send_webchat') && (
        <Labeled label={t('automations.body', 'Message')}>
          <Textarea className="min-h-24" value={step.body ?? ''} onChange={(e) => onPatch({ body: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'ai_generate' && (
        <Labeled label={t('automations.prompt', 'Prompt')}>
          <Textarea className="min-h-24" value={step.prompt ?? ''} onChange={(e) => onPatch({ prompt: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'wait' && (
        <>
          <Labeled label={t('automations.waitMode', 'Mode')}>
            <Select
              value={step.mode ?? 'duration'}
              onValueChange={(v) =>
                // Keep the saved value consistent with what the UI shows: a
                // 'duration' wait always carries a concrete seconds.
                onPatch(v === 'duration' ? { mode: v, seconds: step.seconds ?? 86400 } : { mode: v })
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="duration">{t('automations.duration', 'For a duration')}</SelectItem>
                <SelectItem value="until_reply">{t('automations.untilReply', 'Until reply')}</SelectItem>
              </SelectContent>
            </Select>
          </Labeled>
          {step.mode !== 'until_reply' && (
            <Labeled label={t('automations.waitSeconds', 'Seconds (60–2592000)')}>
              <Input
                type="number"
                value={step.seconds ?? 86400}
                onChange={(e) => onPatch({ seconds: clampInt(e.target.value, 60, 2_592_000) })}
              />
            </Labeled>
          )}
        </>
      )}
      {step.type === 'create_task' && (
        <Labeled label={t('automations.taskTitle', 'Task title')}>
          <Input value={step.title ?? ''} onChange={(e) => onPatch({ title: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'notify_user' && (
        <Labeled label={t('automations.message', 'Message')}>
          <Textarea className="min-h-20" value={step.message ?? ''} onChange={(e) => onPatch({ message: e.target.value })} />
        </Labeled>
      )}
      {(step.type === 'add_tag' || step.type === 'remove_tag') && (
        <Labeled label={t('automations.tag', 'Tag')}>
          <Input value={step.tag ?? ''} onChange={(e) => onPatch({ tag: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'assign_lead' && (
        <Labeled label={t('automations.strategy', 'Strategy')}>
          <Select value={step.strategy ?? 'auto'} onValueChange={(v) => onPatch({ strategy: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">auto</SelectItem>
              <SelectItem value="user">user</SelectItem>
            </SelectContent>
          </Select>
        </Labeled>
      )}
      {['branch', 'ai_classify', 'update_lead', 'http_webhook_out', 'start_workflow'].includes(step.type) && (
        <p className="text-[11px] text-muted-foreground bg-surface-muted rounded p-2">
          {t('automations.editInJson', 'This step has advanced settings — switch to the JSON view to edit its conditions/fields.')}
        </p>
      )}

      <div className="flex items-center gap-1 pt-2 border-t border-border">
        <IconButton variant="ghost" size="sm" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-4 w-4" />
        </IconButton>
        <IconButton variant="ghost" size="sm" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-4 w-4" />
        </IconButton>
        <div className="flex-1" />
        <IconButton variant="ghost" size="sm" aria-label="Delete step" className="text-danger hover:bg-danger-subtle" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-caption text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}

function clampInt(v: string, min: number, max: number): number {
  const n = Math.round(Number(v) || 0);
  return Math.min(max, Math.max(min, n));
}
