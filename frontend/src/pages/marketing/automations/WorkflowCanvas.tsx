import { memo, useCallback, useMemo } from 'react';
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
  Tag, Target, Box,
} from 'lucide-react';
import { buildWorkflowGraph, type AnyStep, type DslGoal } from './workflowGraph';

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
  /** Index of the selected step (null = none). Owned by the parent. */
  selected: number | null;
  onSelect: (index: number | null) => void;
}

/** Presentational React Flow surface: renders the trigger + steps (+ goal) graph
 *  and reports step selection. Step add/edit/reorder live in the parent (palette
 *  rail + property panel) — this component only draws and selects. */
export function WorkflowCanvas({ triggerType, steps, goal, selected, onSelect }: WorkflowCanvasProps) {
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
    onSelect(typeof idx === 'number' ? idx : null);
  }, [onSelect]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesFocusable={false}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
