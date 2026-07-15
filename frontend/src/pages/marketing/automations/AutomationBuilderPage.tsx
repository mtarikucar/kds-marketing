import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { WorkflowCanvas } from './WorkflowCanvas';
import { BuilderTopBar } from './BuilderTopBar';
import { BuilderSettingsRail } from './BuilderSettingsRail';
import { StepPropertyPanel } from './StepPropertyPanel';
import { fromWorkflowDto, fromTemplate, toSavePayload } from './workflowPayload';
import { appendStep, deleteStepAt, moveStepAt } from './stepOps';
import { DEFAULT_BUILDER_STATE, type BuilderState, type WorkflowDto, type WorkflowTemplate } from './automationTypes';
import type { AnyStep, DslGoal } from './workflowGraph';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

/**
 * Full-page workflow builder (replaces the old modal). `/automations/new`
 * (optionally `?template=<key>` / `?ai=<prompt>`) or `/automations/:id/edit`.
 * Owns the typed builder state; the canvas, rail, and property panel are
 * presentational. Backend/API unchanged.
 */
export default function AutomationBuilderPage() {
  const { t } = useTranslation('marketing');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const isEdit = !!id;

  const [state, setState] = useState<BuilderState>(DEFAULT_BUILDER_STATE);
  const [filtersText, setFiltersText] = useState('[]');
  const [filtersError, setFiltersError] = useState<string | undefined>();
  const [selected, setSelected] = useState<number | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [existingStatus, setExistingStatus] = useState('');
  const [existingGoal, setExistingGoal] = useState<DslGoal | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [dirty, setDirty] = useState(false);

  const patchState = (patch: Partial<BuilderState>) => {
    setState((s) => ({ ...s, ...patch }));
    setDirty(true);
  };

  // ── Load (edit mode) ────────────────────────────────────────────────────────
  const query = useQuery<WorkflowDto>({
    queryKey: ['marketing', 'workflow', id],
    queryFn: () => marketingApi.get(`/workflows/${id}`).then((r) => r.data),
    enabled: isEdit,
  });
  useEffect(() => {
    if (!query.data) return;
    setState(fromWorkflowDto(query.data));
    setFiltersText(JSON.stringify(query.data.trigger?.filters ?? [], null, 2));
    setExistingStatus(query.data.status ?? '');
    setExistingGoal(query.data.goal ?? null);
    setDirty(false);
  }, [query.data]);

  // ── Template prefill (new mode, ?template=key) ──────────────────────────────
  const templateKey = params.get('template');
  const templatesQuery = useQuery<WorkflowTemplate[]>({
    queryKey: ['marketing', 'workflows', 'templates'],
    queryFn: () => marketingApi.get('/workflows/templates').then((r) => r.data),
    enabled: !isEdit && !!templateKey,
    staleTime: 5 * 60 * 1000,
  });
  const appliedTemplate = useRef(false);
  useEffect(() => {
    if (isEdit || appliedTemplate.current || !templateKey || !templatesQuery.data) return;
    const tpl = templatesQuery.data.find((x) => x.key === templateKey);
    if (tpl) {
      appliedTemplate.current = true;
      const next = fromTemplate(tpl);
      setState(next);
      setFiltersText(JSON.stringify(next.filters ?? [], null, 2));
    }
  }, [isEdit, templateKey, templatesQuery.data]);

  // ── Mutations ───────────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: () => {
      const payload = toSavePayload(state);
      return isEdit
        ? marketingApi.patch(`/workflows/${id}`, payload)
        : marketingApi.post('/workflows', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'workflows'] });
      toast.success(t('automations.saved', 'Automation saved'));
      navigate('/automations');
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? e.message ?? t('automations.saveFailed', 'Save failed')),
  });

  const draft = useMutation({
    mutationFn: (prompt: string) => marketingApi.post('/workflows/draft', { prompt }).then((r) => r.data),
    onSuccess: (data: WorkflowDto) => {
      patchState({
        triggerType: data.trigger?.type ?? state.triggerType,
        filters: data.trigger?.filters ?? [],
        steps: data.steps ?? [],
      });
      setFiltersText(JSON.stringify(data.trigger?.filters ?? [], null, 2));
      toast.success(t('automations.drafted', 'Draft ready — review and save'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('automations.draftFailed', 'Could not draft')),
  });

  // ── AI prefill (new mode, ?ai=prompt) — draft once on mount ─────────────────
  const aiParam = params.get('ai');
  const ranAi = useRef(false);
  useEffect(() => {
    if (isEdit || ranAi.current || !aiParam) return;
    ranAi.current = true;
    setAiPrompt(aiParam);
    draft.mutate(aiParam);
  }, [isEdit, aiParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleStatus = useMutation({
    mutationFn: () => {
      const next = existingStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
      return marketingApi.post(`/workflows/${id}/status`, { status: next }).then(() => next);
    },
    onSuccess: (next: string) => {
      setExistingStatus(next);
      queryClient.invalidateQueries({ queryKey: ['marketing', 'workflows'] });
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('automations.statusFailed', 'Could not update the automation')),
  });

  // ── Trigger-filters JSON bridge ─────────────────────────────────────────────
  const onFiltersTextChange = (text: string) => {
    setFiltersText(text);
    try {
      const parsed = JSON.parse(text || '[]');
      if (!Array.isArray(parsed)) throw new Error('not-array');
      setFiltersError(undefined);
      patchState({ filters: parsed });
    } catch {
      setFiltersError(t('automations.invalidFiltersJson', 'Filters must be a JSON array.'));
    }
  };

  // ── Step operations ─────────────────────────────────────────────────────────
  const effectiveGoal = state.goal !== undefined ? state.goal : existingGoal;
  const canvasGoal = effectiveGoal && typeof effectiveGoal === 'object' ? effectiveGoal : null;

  const onAddStep = (type: string) => {
    const at = state.steps.length;
    patchState({ steps: appendStep(state.steps, type) });
    setSelected(at);
  };
  const onPatchStep = (patch: Record<string, unknown>) => {
    if (selected == null) return;
    patchState({ steps: state.steps.map((st, i) => (i === selected ? { ...st, ...patch } : st)) });
  };
  const onReplaceStep = (step: AnyStep) => {
    if (selected == null) return;
    patchState({ steps: state.steps.map((st, i) => (i === selected ? step : st)) });
  };
  const onDeleteStep = () => {
    if (selected == null) return;
    const { steps, goal } = deleteStepAt(state.steps, selected, effectiveGoal);
    patchState({ steps, goal: goal === effectiveGoal ? state.goal : goal });
    setSelected(null);
  };
  const onMoveStep = (dir: -1 | 1) => {
    if (selected == null) return;
    const { steps, goal } = moveStepAt(state.steps, selected, dir, effectiveGoal);
    patchState({ steps, goal: goal === effectiveGoal ? state.goal : goal });
    setSelected(selected + dir);
  };

  const onBack = () => {
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    navigate('/automations');
  };

  const selectedStep = selected != null ? state.steps[selected] ?? null : null;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <BuilderTopBar
        name={state.name}
        onNameChange={(name) => patchState({ name })}
        status={existingStatus}
        canToggle={isEdit && !!existingStatus}
        saving={save.isPending}
        saveDisabled={!!filtersError}
        onBack={onBack}
        // Guard as well as disable: never persist while the trigger-filters JSON
        // is invalid (patchState skips the bad value, so Save would write stale
        // filters under a false "saved" toast).
        onSave={() => {
          if (filtersError) return;
          save.mutate();
        }}
        onToggleStatus={() => toggleStatus.mutate()}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <BuilderSettingsRail
          triggerType={state.triggerType}
          onTriggerChange={(triggerType) => patchState({ triggerType })}
          filtersText={filtersText}
          onFiltersTextChange={onFiltersTextChange}
          filtersError={filtersError}
          aiPrompt={aiPrompt}
          onAiPromptChange={setAiPrompt}
          onDraft={() => draft.mutate(aiPrompt)}
          drafting={draft.isPending}
          onAddStep={onAddStep}
        />
        <div className="min-w-0 flex-1">
          <WorkflowCanvas
            triggerType={state.triggerType}
            steps={state.steps}
            goal={canvasGoal}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
        <div className="w-full shrink-0 overflow-y-auto border-t border-border p-3 md:w-80 md:border-l md:border-t-0">
          <StepPropertyPanel
            index={selected}
            step={selectedStep}
            count={state.steps.length}
            onPatch={onPatchStep}
            onReplace={onReplaceStep}
            onDelete={onDeleteStep}
            onMove={onMoveStep}
            onClose={() => setSelected(null)}
          />
        </div>
      </div>

      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        tone="danger"
        title={t('automations.unsavedConfirm.title', 'Discard unsaved changes?')}
        description={t('automations.unsavedConfirm.desc', 'Your edits to this workflow will be lost.')}
        confirmLabel={t('automations.unsavedConfirm.confirm', 'Discard')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          navigate('/automations');
        }}
      />
    </div>
  );
}
