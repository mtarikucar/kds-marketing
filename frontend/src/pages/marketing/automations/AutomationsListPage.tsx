import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Zap, Trash2, Play, Pause, Plus, Pencil, LayoutTemplate, UserPlus, Sparkles, Search,
} from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/Dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/DropdownMenu';
import { EnrollByFilterDialog } from './EnrollByFilterDialog';
import { filterWorkflows } from './listFilters';
import { WORKFLOW_STATUSES } from './constants';
import type { WorkflowRow, WorkflowTemplate } from './automationTypes';

function workflowStatusTone(status: string) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'PAUSED') return 'warning' as const;
  return 'neutral' as const;
}

export default function AutomationsListPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [deleteTarget, setDeleteTarget] = useState<WorkflowRow | null>(null);
  const [enrollTarget, setEnrollTarget] = useState<WorkflowRow | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');

  const { data: workflows } = useQuery<WorkflowRow[]>({
    queryKey: ['marketing', 'workflows'],
    queryFn: () => marketingApi.get('/workflows').then((r) => r.data),
  });

  const { data: templates } = useQuery<WorkflowTemplate[]>({
    queryKey: ['marketing', 'workflows', 'templates'],
    queryFn: () => marketingApi.get('/workflows/templates').then((r) => r.data),
    enabled: templatesOpen,
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'workflows'] });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      marketingApi.post(`/workflows/${id}/status`, { status }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/workflows/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); },
  });

  const rows = useMemo(
    () => filterWorkflows(workflows ?? [], { search, status: statusFilter }),
    [workflows, search, statusFilter],
  );

  const statusOptions = WORKFLOW_STATUSES.map((s) => ({
    value: s,
    label: s === 'ALL' ? t('automations.status.all', 'All') : s,
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('automations.title', 'Automations')}
        description={t('automations.subtitle', 'When something happens, do this. Triggers fire steps — send, wait, branch, create tasks, update leads.')}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="md">
                <Plus className="h-4 w-4" />
                {t('automations.new', 'New automation')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate('/automations/new')}>
                <Zap className="mr-2 h-4 w-4" />
                {t('automations.newBlank', 'Blank automation')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTemplatesOpen(true)}>
                <LayoutTemplate className="mr-2 h-4 w-4" />
                {t('automations.newFromTemplate', 'From a template')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setAiPrompt(''); setAiOpen(true); }}>
                <Sparkles className="mr-2 h-4 w-4" />
                {t('automations.newWithAi', 'Describe with AI')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* ── Search + status filter ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label={t('common.search', 'Search')}
            className="pl-8"
            placeholder={t('automations.searchPlaceholder', 'Search by name or trigger…')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <SegmentedControl
          aria-label={t('automations.statusFilter', 'Status filter')}
          value={statusFilter}
          onChange={setStatusFilter}
          options={statusOptions}
        />
      </div>

      {/* ── Template picker ─────────────────────────────────────────────────── */}
      <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('automations.templatesTitle', 'Start from a template')}</DialogTitle>
            <DialogDescription>
              {t('automations.templatesHint', 'Pick a recipe to pre-fill the builder — you can tweak everything before saving.')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
            {(templates ?? []).map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                onClick={() => { setTemplatesOpen(false); navigate(`/automations/new?template=${encodeURIComponent(tpl.key)}`); }}
                className="rounded-lg border border-border p-3 text-left transition-colors hover:border-primary hover:bg-surface-muted"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{tpl.name}</span>
                  <Badge tone="neutral" size="sm">{tpl.category}</Badge>
                </div>
                <p className="text-caption text-muted-foreground">{tpl.description}</p>
                <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                  {tpl.trigger?.type} · {(tpl.steps ?? []).length} {t('automations.steps', 'steps')}
                </p>
              </button>
            ))}
            {(templates ?? []).length === 0 && (
              <p className="col-span-full py-6 text-center text-caption text-muted-foreground">
                {t('common.loading', 'Loading…')}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AI prompt ───────────────────────────────────────────────────────── */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('automations.aiTitle', 'Describe your automation')}</DialogTitle>
            <DialogDescription>
              {t('automations.aiDialogHint', 'AI drafts the trigger and steps — you review and save them in the builder.')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-24"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder={t('automations.aiPlaceholder', 'e.g. when a new lead comes in, wait 1 hour then send a WhatsApp intro and create a follow-up task')}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button
              disabled={!aiPrompt.trim()}
              onClick={() => { setAiOpen(false); navigate(`/automations/new?ai=${encodeURIComponent(aiPrompt.trim())}`); }}
            >
              <Sparkles className="h-4 w-4" />
              {t('automations.draftBtn', 'Draft')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ──────────────────────────────────────────────────── */}
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

      {/* ── Enroll ──────────────────────────────────────────────────────────── */}
      {enrollTarget && (
        <EnrollByFilterDialog
          workflowId={enrollTarget.id}
          workflowName={enrollTarget.name}
          open={!!enrollTarget}
          onOpenChange={(o) => { if (!o) setEnrollTarget(null); }}
        />
      )}

      {/* ── List ────────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {rows.map((w) => (
          <Card key={w.id}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Zap className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{w.name}</span>
                      <Badge tone={workflowStatusTone(w.status)} size="sm">{w.status}</Badge>
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      {w.trigger?.type}
                      {w.stats && (
                        <span className="ml-2">
                          · {t('automations.statsLine', '{{started}} started → {{completed}} completed', {
                            started: w.stats.started ?? 0, completed: w.stats.completed ?? 0,
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={w.status === 'ACTIVE' ? t('automations.pause', 'Pause') : t('automations.activate', 'Activate')}
                    onClick={() => setStatus.mutate({ id: w.id, status: w.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                  >
                    {w.status === 'ACTIVE' ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('automations.enrollBtn', 'Enroll')}
                    onClick={() => setEnrollTarget(w)}
                  >
                    <UserPlus className="h-5 w-5" />
                  </IconButton>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/automations/${w.id}/edit`)}>
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

        {rows.length === 0 && (
          <EmptyState
            icon={<Zap className="h-10 w-10" />}
            title={t('automations.emptyTitle', 'No automations yet')}
            description={t('automations.empty', 'No automations yet — describe one and let AI draft it.')}
            action={
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setTemplatesOpen(true)}>
                  <LayoutTemplate className="h-4 w-4" />
                  {t('automations.fromTemplate', 'Start from template')}
                </Button>
                <Button onClick={() => navigate('/automations/new')}>
                  <Plus className="h-4 w-4" />
                  {t('automations.new', 'New automation')}
                </Button>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
