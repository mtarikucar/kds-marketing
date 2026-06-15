import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Sparkles, Trash2, PauseCircle, PlayCircle, Plus, Pencil } from 'lucide-react';
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  persona: string;
  tone?: string | null;
  goals?: string | null;
  guardrails?: string | null;
  language: string;
  kbDocIds?: string[] | null;
  captureFields?: string[] | null;
  maxRepliesPerConvoDaily?: number;
  updatedAt?: string;
}

interface KnowledgeRow {
  id: string;
  title: string;
  language: string;
  status: string;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const agentSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  persona: z.string().min(10, 'At least 10 characters').max(4000),
  tone: z.string().max(200).optional(),
  goals: z.string().max(2000).optional(),
  guardrails: z.string().max(2000).optional(),
  language: z.string().min(1),
  captureFields: z.string().optional(),
  maxRepliesPerConvoDaily: z.coerce.number().min(1).max(500),
  kbDocIds: z.array(z.string()),
});

type AgentFormValues = z.infer<typeof agentSchema>;

const DEFAULT_VALUES: AgentFormValues = {
  name: '',
  persona: '',
  tone: '',
  goals: '',
  guardrails: '',
  language: 'tr',
  captureFields: '',
  maxRepliesPerConvoDaily: 30,
  kbDocIds: [],
};

const LANGUAGES = [
  { value: 'tr', label: 'Türkçe' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'uz', label: 'Oʻzbekcha' },
  { value: 'ar', label: 'العربية' },
];

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Agent Studio: the persona + grounding config Conversation/Voice AI run on.
 * P1 ships the config surface; the engine that answers on channels lands in
 * P2. Manager+ surface, gated on the `agentStudio` feature.
 */
export default function AgentStudioPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data: agents } = useQuery<AgentProfile[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
  });

  const { data: docs } = useQuery<KnowledgeRow[]>({
    queryKey: ['marketing', 'ai', 'knowledge'],
    queryFn: () => marketingApi.get('/ai/knowledge').then((r) => r.data),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'ai', 'agents'] });

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<AgentFormValues>({
    resolver: zodResolver(agentSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const kbDocIds = watch('kbDocIds');
  const personaValue = watch('persona');

  const saveAgent = useMutation({
    mutationFn: (values: AgentFormValues) => {
      const payload = {
        name: values.name,
        persona: values.persona,
        tone: values.tone || undefined,
        goals: values.goals || undefined,
        guardrails: values.guardrails || undefined,
        language: values.language,
        maxRepliesPerConvoDaily: values.maxRepliesPerConvoDaily,
        kbDocIds: values.kbDocIds,
        captureFields: values.captureFields
          ? values.captureFields.split(',').map((c) => c.trim()).filter(Boolean)
          : [],
      };
      return editingId
        ? marketingApi.patch(`/ai/agents/${editingId}`, payload)
        : marketingApi.post('/ai/agents', payload);
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditingId(null);
      reset(DEFAULT_VALUES);
      toast.success(t('agents.saved', 'Agent saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('agents.saveFailed', 'Save failed')),
  });

  const toggleAgent = useMutation({
    mutationFn: (a: AgentProfile) =>
      marketingApi.patch(`/ai/agents/${a.id}`, {
        status: a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      }),
    onSuccess: invalidate,
  });

  const deleteAgent = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/ai/agents/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  const openCreate = () => {
    setEditingId(null);
    reset(DEFAULT_VALUES);
    setOpen(true);
  };

  const openEdit = (a: AgentProfile) => {
    setEditingId(a.id);
    reset({
      name: a.name,
      persona: a.persona,
      tone: a.tone ?? '',
      goals: a.goals ?? '',
      guardrails: a.guardrails ?? '',
      language: a.language,
      captureFields: (a.captureFields ?? []).join(', '),
      maxRepliesPerConvoDaily: a.maxRepliesPerConvoDaily ?? 30,
      kbDocIds: a.kbDocIds ?? [],
    });
    setOpen(true);
  };

  const toggleDoc = (id: string) => {
    setValue(
      'kbDocIds',
      kbDocIds.includes(id) ? kbDocIds.filter((x) => x !== id) : [...kbDocIds, id],
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('agents.title', 'Agent Studio')}
        description={t(
          'agents.subtitle',
          'Define the persona, tone and grounding your AI uses to answer customers. Connect channels in the next step.',
        )}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('agents.new', 'New agent')}
          </Button>
        }
      />

      {/* Agent list */}
      <div className="space-y-3">
        {(agents ?? []).map((a) => (
          <Card key={a.id}>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Sparkles className="h-5 w-5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{a.name}</span>
                      <Badge tone={a.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">
                        {a.status === 'ACTIVE'
                          ? t('agents.active', 'Active')
                          : t('agents.paused', 'Paused')}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{a.persona}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={a.status === 'ACTIVE' ? 'Pause agent' : 'Activate agent'}
                    onClick={() => toggleAgent.mutate(a)}
                  >
                    {a.status === 'ACTIVE' ? (
                      <PauseCircle className="h-5 w-5" />
                    ) : (
                      <PlayCircle className="h-5 w-5" />
                    )}
                  </IconButton>
                  <Button variant="outline" size="sm" onClick={() => openEdit(a)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('common.edit', 'Edit')}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Delete agent"
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(a.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {(agents ?? []).length === 0 && (
          <EmptyState
            icon={<Sparkles className="h-10 w-10" />}
            title={t('agents.empty', 'No agents yet')}
            description={t(
              'agents.emptyDesc',
              'Create one to define how your AI talks to customers.',
            )}
            action={
              <Button onClick={openCreate} size="md">
                <Plus className="h-4 w-4" />
                {t('agents.new', 'New agent')}
              </Button>
            }
          />
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={open} onOpenChange={(v) => { if (!v) { setOpen(false); setEditingId(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('agents.edit', 'Edit agent') : t('agents.new', 'New agent')}
            </DialogTitle>
            <DialogDescription>
              {t('agents.formDesc', 'Configure the AI persona and grounding.')}
            </DialogDescription>
          </DialogHeader>

          <form
            id="agent-form"
            onSubmit={handleSubmit((v) => saveAgent.mutate(v))}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label={t('agents.name', 'Agent name')}
                error={errors.name?.message}
                required
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    placeholder="Reception bot"
                    maxLength={120}
                    {...register('name')}
                  />
                )}
              </Field>

              <Field label={t('agents.language', 'Language')} error={errors.language?.message} required>
                {({ id }) => (
                  <Controller
                    name="language"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LANGUAGES.map((l) => (
                            <SelectItem key={l.value} value={l.value}>
                              {l.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            </div>

            <Field
              label={t('agents.persona', 'Persona (who is this agent?)')}
              error={errors.persona?.message}
              hint={`${personaValue?.length ?? 0}/4000 · ${t('agents.personaMin', 'min 10 characters')}`}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="min-h-24"
                  maxLength={4000}
                  placeholder={t(
                    'agents.personaPlaceholder',
                    'e.g. You are the friendly front-desk assistant for a family pizzeria. Greet warmly, answer in short sentences…',
                  )}
                  {...register('persona')}
                />
              )}
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label={t('agents.tone', 'Tone (optional)')} error={errors.tone?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    maxLength={200}
                    placeholder={t('agents.tonePlaceholder', 'warm, concise, professional')}
                    {...register('tone')}
                  />
                )}
              </Field>

              <Field
                label={t('agents.maxReplies', 'Max AI replies / conversation / day')}
                error={errors.maxRepliesPerConvoDaily?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="number"
                    min={1}
                    max={500}
                    {...register('maxRepliesPerConvoDaily')}
                  />
                )}
              </Field>
            </div>

            <Field label={t('agents.goals', 'Goals (optional)')} error={errors.goals?.message}>
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="min-h-16"
                  maxLength={2000}
                  placeholder={t(
                    'agents.goalsPlaceholder',
                    'What should the agent try to achieve? e.g. book a table, capture phone + party size',
                  )}
                  {...register('goals')}
                />
              )}
            </Field>

            <Field
              label={t('agents.guardrails', 'Guardrails (optional)')}
              error={errors.guardrails?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="min-h-16"
                  maxLength={2000}
                  placeholder={t(
                    'agents.guardrailsPlaceholder',
                    'What must it never do? e.g. never quote prices, never promise refunds',
                  )}
                  {...register('guardrails')}
                />
              )}
            </Field>

            <Field
              label={t('agents.capture', 'Fields to capture (comma separated)')}
              error={errors.captureFields?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="name, phone, partySize"
                  {...register('captureFields')}
                />
              )}
            </Field>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t('agents.knowledge', 'Knowledge base grounding')}
              </p>
              {(docs ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    'agents.noDocs',
                    'No knowledge docs yet — add some in the Knowledge Base to ground replies in facts.',
                  )}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(docs ?? []).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleDoc(d.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                        kbDocIds.includes(d.id)
                          ? 'bg-primary/10 text-primary border-primary'
                          : 'bg-surface text-muted-foreground border-border hover:bg-surface-muted'
                      }`}
                    >
                      {d.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </form>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setOpen(false); setEditingId(null); }}
              disabled={saveAgent.isPending}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              form="agent-form"
              loading={saveAgent.isPending}
            >
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title={t('agents.deleteTitle', 'Delete agent?')}
        description={t('agents.deleteDesc', 'This cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={deleteAgent.isPending}
        onConfirm={() => deleteTarget && deleteAgent.mutate(deleteTarget)}
      />
    </div>
  );
}
