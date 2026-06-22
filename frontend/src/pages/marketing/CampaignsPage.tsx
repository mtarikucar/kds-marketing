import { useState } from 'react';
import { useForm, useWatch, Controller, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Megaphone,
  Trash2,
  Send,
  Sparkles,
  Plus,
  Pause,
  Play,
  Pencil,
} from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { listEmailTemplates, getEmailTemplate, type EmailTemplateRow } from '../../features/marketing/api/email-templates.service';
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
import { Separator } from '@/components/ui/Separator';

// ── Types ────────────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  stats?: Record<string, number> | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
const FILTER_FIELDS = ['status', 'city', 'businessType', 'priority', 'source'] as const;
const OPS = ['eq', 'neq', 'in', 'contains', 'gte', 'lte'] as const;

// ── Schema ────────────────────────────────────────────────────────────────────

const filterRowSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.string(),
});

const campaignSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  channel: z.enum(CHANNELS),
  subject: z.string().max(200).optional(),
  body: z.string().min(1, 'Required').max(20000),
  bodyHtml: z.string().optional(),
  emailTemplateId: z.string().optional(),
  filters: z.array(filterRowSchema),
});
type CampaignFormValues = z.infer<typeof campaignSchema>;

const DEFAULT_VALUES: CampaignFormValues = {
  name: '',
  channel: 'EMAIL',
  subject: '',
  body: '',
  bodyHtml: '',
  emailTemplateId: '',
  filters: [],
};

// ── Badge helpers ─────────────────────────────────────────────────────────────

function campaignStatusTone(status: string) {
  if (status === 'SENT') return 'success' as const;
  if (status === 'SENDING') return 'info' as const;
  if (status === 'PAUSED') return 'warning' as const;
  return 'neutral' as const;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string>('');
  const [aiGoal, setAiGoal] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CampaignRow | null>(null);

  // ── Query ─────────────────────────────────────────────────────────────────
  const { data: campaigns } = useQuery<CampaignRow[]>({
    queryKey: ['marketing', 'campaigns'],
    queryFn: () => marketingApi.get('/campaigns').then((r) => r.data),
    refetchInterval: 15_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'campaigns'] });

  // ── Form ──────────────────────────────────────────────────────────────────
  const form = useForm<CampaignFormValues>({
    resolver: zodResolver(campaignSchema),
    defaultValues: DEFAULT_VALUES,
  });
  const selectedChannel = useWatch({ control: form.control, name: 'channel' });
  const selectedTemplateId = useWatch({ control: form.control, name: 'emailTemplateId' });

  const { data: emailTemplates } = useQuery<EmailTemplateRow[]>({
    queryKey: ['marketing', 'email-templates'],
    queryFn: listEmailTemplates,
    enabled: selectedChannel === 'EMAIL',
  });

  // Attach an HTML template (fetches its compiled HTML) or clear it ('' = plain text).
  const pickTemplate = async (id: string) => {
    if (!id) {
      form.setValue('emailTemplateId', '');
      form.setValue('bodyHtml', '');
      return;
    }
    try {
      const tpl = await getEmailTemplate(id);
      form.setValue('emailTemplateId', id);
      form.setValue('bodyHtml', tpl.compiledHtml ?? '');
    } catch {
      toast.error(t('campaigns.templateLoadFailed', 'Could not load the template'));
    }
  };

  const { fields: filterFields, append: appendFilter, remove: removeFilter } = useFieldArray({
    control: form.control,
    name: 'filters',
  });

  const openCreate = () => {
    setEditId('');
    form.reset(DEFAULT_VALUES);
    setAiGoal('');
    setFormOpen(true);
  };

  const openEdit = async (c: CampaignRow) => {
    const full = await marketingApi.get(`/campaigns/${c.id}`).then((r) => r.data);
    setEditId(full.id);
    form.reset({
      name: full.name,
      channel: full.channel,
      subject: full.subject ?? '',
      body: full.body,
      bodyHtml: full.bodyHtml ?? '',
      emailTemplateId: full.emailTemplateId ?? '',
      filters: (full.audienceFilter ?? []).map((f: any) => ({
        field: String(f.field).replace('lead.', ''),
        op: f.op,
        value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? ''),
      })),
    });
    setAiGoal('');
    setFormOpen(true);
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const buildPayload = (values: CampaignFormValues) => ({
    name: values.name,
    channel: values.channel,
    subject: values.subject || undefined,
    body: values.body,
    // Always send these (as '' when cleared) so the backend actually CLEARS a
    // previously-attached template — sending undefined would leave the stale
    // HTML in the DB and keep shipping it. The service maps '' → null.
    bodyHtml: values.channel === 'EMAIL' ? (values.bodyHtml || '') : '',
    emailTemplateId: values.channel === 'EMAIL' ? (values.emailTemplateId || '') : '',
    audienceFilter: values.filters
      .filter((f) => f.field && f.value)
      .map((f) => ({
        field: `lead.${f.field}`,
        op: f.op,
        value: f.op === 'in' ? f.value.split(',').map((s) => s.trim()) : f.value,
      })),
  });

  const save = useMutation({
    mutationFn: (values: CampaignFormValues) =>
      editId
        ? marketingApi.patch(`/campaigns/${editId}`, buildPayload(values))
        : marketingApi.post('/campaigns', buildPayload(values)),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast.success(t('campaigns.saved', 'Campaign saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.saveFailed', 'Save failed')),
  });

  const compose = useMutation({
    mutationFn: () =>
      marketingApi.post('/ai/compose', {
        kind:
          selectedChannel === 'EMAIL'
            ? 'email'
            : selectedChannel === 'SMS'
              ? 'sms'
              : 'social',
        goal: aiGoal,
      }),
    onSuccess: ({ data }) => {
      if (data.subject) form.setValue('subject', data.subject);
      if (data.body) form.setValue('body', data.body);
      toast.success(t('campaigns.composed', 'Draft ready'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.composeFailed', 'Compose failed')),
  });

  const launch = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/campaigns/${id}/launch`),
    onSuccess: ({ data }) => {
      invalidate();
      toast.success(t('campaigns.launched', `Launched to ${data.recipients} recipients`));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.launchFailed', 'Launch failed')),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      marketingApi.post(`/campaigns/${id}/${action}`),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/campaigns/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('campaigns.title', 'Campaigns')}
        description={t(
          'campaigns.subtitle',
          'Blast email, SMS or WhatsApp to a filtered slice of your leads. Opt-outs and an unsubscribe link are handled for you.',
        )}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('campaigns.new', 'New campaign')}
          </Button>
        }
      />

      {/* ── Create/Edit dialog ───────────────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editId
                ? t('campaigns.editTitle', 'Edit campaign')
                : t('campaigns.new', 'New campaign')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'campaigns.formHint',
                'Build your message and target audience. Opt-outs are handled automatically.',
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Name */}
              <div className="sm:col-span-2">
                <Field
                  label={t('campaigns.name', 'Name')}
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
              </div>

              {/* Channel */}
              <Field label={t('campaigns.channel', 'Channel')}>
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="channel"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CHANNELS.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            </div>

            {/* Audience filter builder */}
            <div>
              <p className="text-caption font-medium text-muted-foreground mb-2">
                {t(
                  'campaigns.audience',
                  'Audience (leads matching all rules; empty = everyone opted-in)',
                )}
              </p>
              <div className="space-y-2">
                {filterFields.map((f, i) => (
                  <div key={f.id} className="flex flex-wrap gap-2">
                    {/* Field select */}
                    <Controller
                      control={form.control}
                      name={`filters.${i}.field`}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="flex-1 min-w-[8rem]">
                            <SelectValue placeholder={t('campaigns.field', 'field')} />
                          </SelectTrigger>
                          <SelectContent>
                            {FILTER_FIELDS.map((x) => (
                              <SelectItem key={x} value={x}>
                                {x}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {/* Op select */}
                    <Controller
                      control={form.control}
                      name={`filters.${i}.op`}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {OPS.map((x) => (
                              <SelectItem key={x} value={x}>
                                {x}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {/* Value */}
                    <Input
                      placeholder={t('campaigns.value', 'value')}
                      className="flex-1 min-w-[8rem]"
                      {...form.register(`filters.${i}.value`)}
                    />
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove rule"
                      className="text-danger hover:bg-danger-subtle"
                      onClick={() => removeFilter(i)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => appendFilter({ field: '', op: 'eq', value: '' })}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  {t('campaigns.addRule', 'Add rule')}
                </button>
              </div>
            </div>

            <Separator />

            {/* AI compose */}
            <Callout tone="info">
              <div className="flex items-center gap-1 mb-1.5 font-medium text-sm">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('campaigns.aiCompose', 'AI copywriter')}
              </div>
              <div className="flex gap-2">
                <Input
                  value={aiGoal}
                  onChange={(e) => setAiGoal(e.target.value)}
                  placeholder={t(
                    'campaigns.aiGoal',
                    'Goal — e.g. announce a 20% spring discount',
                  )}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => compose.mutate()}
                  disabled={!aiGoal.trim() || compose.isPending}
                  loading={compose.isPending}
                  className="shrink-0"
                >
                  {t('campaigns.write', 'Write')}
                </Button>
              </div>
            </Callout>

            {/* Subject (EMAIL only) */}
            {selectedChannel === 'EMAIL' && (
              <Field label={t('campaigns.subject', 'Subject')}>
                {({ id }) => (
                  <Input id={id} maxLength={200} {...form.register('subject')} />
                )}
              </Field>
            )}

            {/* HTML email template (EMAIL only) */}
            {selectedChannel === 'EMAIL' && (
              <Field label={t('campaigns.emailTemplate', 'HTML template (optional)')}>
                {({ id }) => (
                  <div className="flex items-center gap-2">
                    <Select value={selectedTemplateId || '__none__'} onValueChange={(v) => pickTemplate(v === '__none__' ? '' : v)}>
                      <SelectTrigger id={id} className="flex-1">
                        <SelectValue placeholder={t('campaigns.plainText', 'Plain text only')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t('campaigns.plainText', 'Plain text only')}</SelectItem>
                        {(emailTemplates ?? []).map((tpl) => (
                          <SelectItem key={tpl.id} value={tpl.id}>{tpl.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {form.watch('bodyHtml') ? (
                      <Badge tone="success" size="sm">{t('campaigns.htmlAttached', 'HTML attached')}</Badge>
                    ) : null}
                  </div>
                )}
              </Field>
            )}

            {/* Body */}
            <Field
              label={selectedChannel === 'EMAIL' && form.watch('bodyHtml')
                ? t('campaigns.bodyPlainFallback', 'Plain-text fallback')
                : t('campaigns.body', 'Message')}
              error={form.formState.errors.body?.message}
              required
            >
              {({ id, invalid }) => (
                <Textarea
                  id={id}
                  aria-invalid={invalid}
                  className="min-h-40"
                  maxLength={20000}
                  placeholder="Hi {{lead.contactPerson}}, …"
                  {...form.register('body')}
                />
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
        title={t('campaigns.deleteTitle', 'Delete campaign?')}
        description={t(
          'campaigns.deleteDesc',
          'Sent stats will be lost. This cannot be undone.',
        )}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      {/* ── Campaign list ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {(campaigns ?? []).map((c) => (
          <Card key={c.id}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Megaphone className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{c.name}</span>
                      <Badge tone="neutral" size="sm" className="uppercase">
                        {c.channel}
                      </Badge>
                      <Badge tone={campaignStatusTone(c.status)} size="sm">
                        {c.status}
                      </Badge>
                    </div>
                    {c.stats && (
                      <p className="text-caption text-muted-foreground mt-0.5">
                        {c.stats.sent ?? 0}/{c.stats.recipients ?? 0}{' '}
                        {t('campaigns.sent', 'sent')} ·{' '}
                        {c.stats.opened ?? 0} {t('campaigns.opened', 'opened')} ·{' '}
                        {c.stats.clicked ?? 0} {t('campaigns.clicked', 'clicked')} ·{' '}
                        {c.stats.unsubscribed ?? 0} {t('campaigns.unsub', 'unsub')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {c.status === 'DRAFT' && (
                    <Button size="sm" onClick={() => launch.mutate(c.id)} loading={launch.isPending}>
                      <Send className="h-3.5 w-3.5" />
                      {t('campaigns.launch', 'Launch')}
                    </Button>
                  )}
                  {c.status === 'SENDING' && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('campaigns.pause', 'Pause')}
                      onClick={() => act.mutate({ id: c.id, action: 'pause' })}
                    >
                      <Pause className="h-5 w-5" />
                    </IconButton>
                  )}
                  {c.status === 'PAUSED' && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('campaigns.resume', 'Resume')}
                      onClick={() => act.mutate({ id: c.id, action: 'resume' })}
                    >
                      <Play className="h-5 w-5" />
                    </IconButton>
                  )}
                  {c.status === 'DRAFT' && (
                    <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('common.edit', 'Edit')}
                    </Button>
                  )}
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('common.delete', 'Delete')}
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(c)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {(campaigns ?? []).length === 0 && (
          <EmptyState
            icon={<Megaphone className="h-10 w-10" />}
            title={t('campaigns.emptyTitle', 'No campaigns yet')}
            description={t(
              'campaigns.empty',
              'No campaigns yet — create one and let AI write the copy.',
            )}
            action={
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('campaigns.new', 'New campaign')}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
