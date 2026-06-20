import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Zap,
  Trash2,
  Play,
  Pause,
  Sparkles,
  Plus,
  Pencil,
} from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Callout } from '@/components/ui/Callout';

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  trigger?: { type?: string };
  version: number;
  stats?: { started?: number; completed?: number } | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TRIGGER_TYPES = [
  'lead.created',
  'lead.status_changed',
  'conversation.message.received',
  'form.submitted',
  'booking.created',
  'review.received',
  'task.completed',
  'tag.added',
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
] as const;

const STEP_TEMPLATES: Record<string, unknown> = {
  send_email: { type: 'send_email', subject: 'Hello', body: 'Hi {{lead.contactPerson}}, …' },
  send_whatsapp: { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}} 👋' },
  send_sms: { type: 'send_sms', body: 'Hi {{lead.contactPerson}}' },
  ai_generate: { type: 'ai_generate', prompt: 'Write a friendly opener for {{lead.businessName}}', saveAs: 'opener' },
  wait: { type: 'wait', mode: 'duration', seconds: 86400 },
  branch: { type: 'branch', filters: [{ field: 'lead.status', op: 'eq', value: 'NEW' }] },
  create_task: { type: 'create_task', title: 'Follow up with {{lead.contactPerson}}', dueInHours: 24 },
  assign_lead: { type: 'assign_lead', strategy: 'auto' },
  update_lead: { type: 'update_lead', set: { status: 'CONTACTED' } },
  add_tag: { type: 'add_tag', tag: 'customer' },
  remove_tag: { type: 'remove_tag', tag: 'prospect' },
  notify_user: { type: 'notify_user', message: 'New lead {{lead.businessName}} entered the workflow' },
  stop_workflow: { type: 'stop_workflow' },
};

// ── Schema ────────────────────────────────────────────────────────────────────

const workflowSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  triggerType: z.string().min(1),
  filters: z.string().refine(
    (v) => { try { JSON.parse(v || '[]'); return true; } catch { return false; } },
    { message: 'Must be valid JSON' },
  ),
  steps: z.string().refine(
    (v) => { try { JSON.parse(v || '[]'); return true; } catch { return false; } },
    { message: 'Must be valid JSON' },
  ),
});
type WorkflowFormValues = z.infer<typeof workflowSchema>;

const DEFAULT_VALUES: WorkflowFormValues = {
  name: '',
  triggerType: 'lead.created',
  filters: '[]',
  steps: '[]',
};

// ── Badge helpers ─────────────────────────────────────────────────────────────

function workflowStatusTone(status: string) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'PAUSED') return 'warning' as const;
  return 'neutral' as const;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AutomationsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string>('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WorkflowRow | null>(null);

  // ── Query ─────────────────────────────────────────────────────────────────
  const { data: workflows } = useQuery<WorkflowRow[]>({
    queryKey: ['marketing', 'workflows'],
    queryFn: () => marketingApi.get('/workflows').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'workflows'] });

  // ── Form ──────────────────────────────────────────────────────────────────
  const form = useForm<WorkflowFormValues>({
    resolver: zodResolver(workflowSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const openCreate = () => {
    setEditId('');
    form.reset(DEFAULT_VALUES);
    setAiPrompt('');
    setFormOpen(true);
  };

  const openEdit = async (w: WorkflowRow) => {
    const full = await marketingApi.get(`/workflows/${w.id}`).then((r) => r.data);
    setEditId(full.id);
    form.reset({
      name: full.name,
      triggerType: full.trigger?.type ?? 'lead.created',
      filters: JSON.stringify(full.trigger?.filters ?? [], null, 2),
      steps: JSON.stringify(full.steps ?? [], null, 2),
    });
    setAiPrompt('');
    setFormOpen(true);
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: (values: WorkflowFormValues) => {
      const payload = {
        name: values.name,
        trigger: { type: values.triggerType, filters: JSON.parse(values.filters || '[]') },
        steps: JSON.parse(values.steps || '[]'),
      };
      return editId
        ? marketingApi.patch(`/workflows/${editId}`, payload)
        : marketingApi.post('/workflows', payload);
    },
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast.success(t('automations.saved', 'Automation saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? e.message ?? t('automations.saveFailed', 'Save failed')),
  });

  const draft = useMutation({
    mutationFn: () => marketingApi.post('/workflows/draft', { prompt: aiPrompt }),
    onSuccess: ({ data }) => {
      form.setValue('triggerType', data.trigger?.type ?? form.getValues('triggerType'));
      form.setValue('filters', JSON.stringify(data.trigger?.filters ?? [], null, 2));
      form.setValue('steps', JSON.stringify(data.steps ?? [], null, 2));
      toast.success(t('automations.drafted', 'Draft ready — review and save'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('automations.draftFailed', 'Could not draft')),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      marketingApi.post(`/workflows/${id}/status`, { status }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/workflows/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  const appendStep = (key: string) => {
    const current = form.getValues('steps');
    let steps: unknown[];
    try { steps = JSON.parse(current || '[]'); } catch { steps = []; }
    if (!Array.isArray(steps)) steps = [];
    steps.push(STEP_TEMPLATES[key]);
    form.setValue('steps', JSON.stringify(steps, null, 2), { shouldDirty: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('automations.title', 'Automations')}
        description={t(
          'automations.subtitle',
          'When something happens, do this. Triggers fire steps — send, wait, branch, create tasks, update leads.',
        )}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('automations.new', 'New automation')}
          </Button>
        }
      />

      {/* ── Create/Edit dialog ───────────────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editId
                ? t('automations.editTitle', 'Edit automation')
                : t('automations.new', 'New automation')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'automations.formHint',
                'Define a trigger and build the steps that run when it fires.',
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
            {/* AI assist */}
            <Callout tone="info">
              <div className="flex items-center gap-1 mb-1.5 font-medium text-sm">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('automations.aiAssist', 'Describe it — AI drafts the steps')}
              </div>
              <div className="flex gap-2">
                <Input
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder={t(
                    'automations.aiPlaceholder',
                    'e.g. when a new lead comes in, wait 1 hour then send a WhatsApp intro and create a follow-up task',
                  )}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => draft.mutate()}
                  disabled={!aiPrompt.trim() || draft.isPending}
                  loading={draft.isPending}
                  className="shrink-0"
                >
                  {t('automations.draftBtn', 'Draft')}
                </Button>
              </div>
            </Callout>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Name */}
              <Field
                label={t('automations.name', 'Name')}
                error={form.formState.errors.name?.message}
                required
              >
                {({ id, invalid }) => (
                  <Input
                    id={id}
                    aria-invalid={invalid}
                    maxLength={120}
                    {...form.register('name')}
                  />
                )}
              </Field>

              {/* Trigger */}
              <Field label={t('automations.trigger', 'Trigger')}>
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="triggerType"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TRIGGER_TYPES.map((tt) => (
                            <SelectItem key={tt} value={tt}>
                              {tt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            </div>

            {/* Filters */}
            <Field
              label={t('automations.filters', 'Trigger filters (JSON, optional)')}
              error={form.formState.errors.filters?.message}
            >
              {({ id, invalid }) => (
                <Textarea
                  id={id}
                  aria-invalid={invalid}
                  className="font-mono min-h-16"
                  {...form.register('filters')}
                />
              )}
            </Field>

            {/* Steps */}
            <Field
              label={t('automations.steps', 'Steps (JSON)')}
              error={form.formState.errors.steps?.message}
              required
            >
              {({ id, invalid }) => (
                <div>
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {Object.keys(STEP_TEMPLATES).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => appendStep(k)}
                        title={`+ ${k}`}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-surface-muted flex items-center gap-0.5"
                      >
                        <Plus className="h-3 w-3" aria-hidden="true" />
                        {k}
                      </button>
                    ))}
                  </div>
                  <Textarea
                    id={id}
                    aria-invalid={invalid}
                    className="font-mono min-h-48"
                    {...form.register('steps')}
                  />
                </div>
              )}
            </Field>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={save.isPending}>
                {t('common.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('automations.deleteTitle', 'Delete automation?')}
        description={t('automations.deleteDesc', 'Running instances will be cancelled.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      {/* ── Workflow list ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {(workflows ?? []).map((w) => (
          <Card key={w.id}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Zap className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{w.name}</span>
                      <Badge tone={workflowStatusTone(w.status)} size="sm">
                        {w.status}
                      </Badge>
                    </div>
                    <p className="text-caption text-muted-foreground mt-0.5">{w.trigger?.type}</p>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={
                      w.status === 'ACTIVE'
                        ? t('automations.pause', 'Pause')
                        : t('automations.activate', 'Activate')
                    }
                    onClick={() =>
                      setStatus.mutate({
                        id: w.id,
                        status: w.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
                      })
                    }
                  >
                    {w.status === 'ACTIVE' ? (
                      <Pause className="h-5 w-5" />
                    ) : (
                      <Play className="h-5 w-5" />
                    )}
                  </IconButton>
                  <Button variant="outline" size="sm" onClick={() => openEdit(w)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('common.edit', 'Edit')}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('common.delete', 'Delete')}
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(w)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {(workflows ?? []).length === 0 && (
          <EmptyState
            icon={<Zap className="h-10 w-10" />}
            title={t('automations.emptyTitle', 'No automations yet')}
            description={t(
              'automations.empty',
              'No automations yet — describe one and let AI draft it.',
            )}
            action={
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('automations.new', 'New automation')}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
