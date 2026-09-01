import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useSearchParams, Link } from 'react-router-dom';
import { useCreateParam } from '../../../features/marketing/hooks/useCreateParam';
import { Plus, AlertTriangle, CheckCircle2, Play, Pencil, Trash2, ClipboardList } from 'lucide-react';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { MarketingTask, MarketingUserInfo } from '../../../features/marketing/types';
import type { TaskFormValues } from '../../../features/marketing/schemas';
import { fmtDateTime } from '../../../features/marketing/utils/format';
import { localDateTimeToIso } from '../../../features/marketing/utils/datetime';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/components/ui/cn';
import { TaskFormDialog } from './TaskFormDialog';

// ── Badge tone helpers ──────────────────────────────────────────────────────

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: 'neutral',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
};

const PRIORITY_TONE: Record<string, BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'primary',
  HIGH: 'warning',
  URGENT: 'danger',
};

const TYPE_TONE: Record<string, BadgeTone> = {
  CALL: 'info',
  VISIT: 'primary',
  DEMO: 'warning',
  FOLLOW_UP: 'neutral',
  MEETING: 'success',
  OTHER: 'neutral',
};

interface RepRow extends MarketingUserInfo {
  role: string;
}

// ── Component ───────────────────────────────────────────────────────────────

/**
 * Build the task create/update payload.
 *
 * CREATE: omit an empty optional so we don't store "".
 * EDIT: send `description` EXPLICITLY (empty when blanked) so clearing it
 * actually persists — an omitted key on the PATCH is a no-op (partial update),
 * which is why a blanked description used to be silently kept.
 */
export function buildTaskPayload(values: TaskFormValues, isEdit: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: values.title,
    type: values.type,
    priority: values.priority,
    // Combine the local date + time into a full ISO datetime so the hour the
    // rep picked is exactly what gets stored (no off-by-one, no end-of-day).
    dueDate: localDateTimeToIso(values.dueDate, values.dueTime),
    ...(values.leadId ? { leadId: values.leadId } : {}),
    ...(values.assignedToId ? { assignedToId: values.assignedToId } : {}),
  };
  if (isEdit) {
    payload.description = values.description ?? '';
  } else if (values.description) {
    payload.description = values.description;
  }
  return payload;
}

/**
 * This page's `?tab=` vocabulary — the tab strip's order, and the values the
 * deep link accepts.
 *
 * EXPORTED for the same reason as InboxPage's `CONFIG_TABS`: `tab` is the one
 * search-param name two pages read, and this page is rendered INSIDE that one
 * as its Görevler view. The two sets being disjoint is what keeps a
 * `?tab=overdue` link from opening a config surface, and it is a coincidence of
 * two vocabularies rather than anything either side enforces — so
 * `tabParam.contract.test.ts` enforces it, over these two lists.
 */
export const TASK_TABS = ['all', 'today', 'overdue'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export interface TasksPageProps {
  /**
   * Rendered inside another page's surface rather than at `/tasks`.
   *
   * Swaps the page CHROME — its own `<h1>` and header action — for the host's,
   * and nothing else. The tabs, the status filter, the server-driven sort, the
   * per-row complete / edit / delete and the create dialog are the same code.
   */
  embedded?: boolean;
  /**
   * Report the person a task belongs to, instead of navigating into their
   * record. Present only when a host is listening: `/tasks` passes nothing and
   * keeps its link, because there is no surface there to report to.
   */
  onSelectPerson?: (person: { id: string; businessName?: string }) => void;
  /** Who the host has open, so this list can mark them across a view switch. */
  selectedLeadId?: string | null;
}

/**
 * The workspace task list. Also the person surface's **Görevler** view
 * (2026-09-01 design, stage 2) — one of four arrangements of the same people in
 * its left column, and the same `embedded` chrome swap the other pages on that
 * surface already take.
 */
export default function TasksPage({
  embedded,
  onSelectPerson,
  selectedLeadId,
}: TasksPageProps = {}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');

  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');

  // Tab filter (all / today / overdue) — seeded from ?tab= URL param
  const [tab, setTab] = useState<TaskTab>(
    initialTab === 'today' || initialTab === 'overdue' ? initialTab : 'all',
  );

  // Status filter for "all" tab (preserves query param `status`)
  const [status, setStatus] = useState('');

  // Server-side sort for the "all" tab. The DataTable headers were sortable but
  // uncontrolled, so a click only reordered the visible 20 rows of the paginated
  // /tasks response. Drive the sort through the query so the top rows reflect the
  // whole dataset. The today/overdue tabs return the FULL set (no pagination), so
  // the same controlled state just client-sorts them in memory — also correct.
  // Column ids match the backend allow-list (title/type/status/priority/dueDate).
  const [sorting, setSorting] = useState<SortingState>([]);
  const sortBy = sorting[0]?.id;
  const sortOrder: 'asc' | 'desc' | undefined = sorting[0]
    ? sorting[0].desc
      ? 'desc'
      : 'asc'
    : undefined;

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<MarketingTask | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MarketingTask | null>(null);

  // ── Query ────────────────────────────────────────────────────────────────

  const queryKey =
    tab === 'today'
      ? ['marketing', 'tasks', 'today']
      : tab === 'overdue'
        ? ['marketing', 'tasks', 'overdue']
        : ['marketing', 'tasks', { status, sortBy, sortOrder }];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => {
      if (tab === 'today') return marketingApi.get('/tasks/today').then((r) => r.data);
      if (tab === 'overdue') return marketingApi.get('/tasks/overdue').then((r) => r.data);
      return marketingApi
        .get('/tasks', { params: { status: status || undefined, sortBy, sortOrder } })
        .then((r) => r.data?.data || r.data);
    },
  });

  const tasks: MarketingTask[] = Array.isArray(data) ? data : data?.data || [];

  // ── Mutations ────────────────────────────────────────────────────────────

  /**
   * A task write moves two things: the task lists, and the RECORD of whoever
   * the task belongs to.
   *
   * `['marketing','lead']` is the prefix, not one id: this list shows many
   * people's tasks and the row being completed need not be the person the host
   * has open. Invalidating the prefix refetches only the lead records that are
   * actually mounted — at most the one on screen — and leaves the rest to go
   * stale in cache, which is what a prefix invalidation is for.
   *
   * This is the mirror of `useLeadRecordInvalidate`, which names
   * ['marketing','tasks'] so a write on the record CARD refreshes this list.
   * Both directions or neither: half of the round trip is a section that
   * disagrees with the column beside it about a task somebody just ticked off.
   */
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'lead'] });
  };

  const completeMutation = useMutation({
    mutationFn: (taskId: string) => marketingApi.patch(`/tasks/${taskId}/complete`),
    onSuccess: () => {
      invalidate();
      toast.success(t('tasks.completeSuccess'));
    },
    onError: () => { toast.error('Failed to complete task'); },
  });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/tasks', payload),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast.success(t('tasks.createSuccess'));
    },
    onError: () => { toast.error('Failed to create task'); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/tasks/${id}`, data),
    onSuccess: () => {
      invalidate();
      setEditingTask(null);
      toast.success('Task updated');
    },
    onError: () => { toast.error('Failed to update task'); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/tasks/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('tasks.deleteSuccess'));
    },
    onError: () => { toast.error('Failed to delete task'); },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      marketingApi.patch(`/tasks/${id}`, { status }),
    onSuccess: () => { invalidate(); toast.success('Task status updated'); },
    onError: () => { toast.error('Failed to update task status'); },
  });

  // ── Form submit handlers ─────────────────────────────────────────────────

  const handleFormSubmit = (values: TaskFormValues) => {
    const payload = buildTaskPayload(values, !!editingTask);
    if (editingTask) {
      updateMutation.mutate({ id: editingTask.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const openEdit = (task: MarketingTask) => {
    setEditingTask(task);
    setFormOpen(true);
  };

  const openCreate = () => {
    setEditingTask(null);
    setFormOpen(true);
  };

  // Honor ?create=1 from the global "+ Create" menu / command palette.
  // Not when embedded: `?create=1` belongs to whichever page owns the URL, and
  // consuming it also strips it. See useCreateParam's `enabled`.
  useCreateParam(openCreate, !embedded);

  const handleDialogClose = (open: boolean) => {
    setFormOpen(open);
    if (!open) setEditingTask(null);
  };

  // ── Columns ──────────────────────────────────────────────────────────────

  const columns: ColumnDef<MarketingTask, unknown>[] = [
    {
      id: 'complete',
      header: '',
      size: 40,
      cell: ({ row }) => {
        const task = row.original;
        const done = task.status === 'COMPLETED';
        return (
          <IconButton
            aria-label={done ? t('taskStatus.COMPLETED') : t('tasks.completeSuccess')}
            size="sm"
            variant={done ? 'secondary' : 'ghost'}
            disabled={done || (completeMutation.isPending && completeMutation.variables === task.id)}
            onClick={() => !done && completeMutation.mutate(task.id)}
            className={cn('rounded-full', done && 'text-success')}
          >
            <CheckCircle2 className="h-4 w-4" />
          </IconButton>
        );
      },
    },
    {
      accessorKey: 'title',
      header: t('tasks.table.title'),
      cell: ({ row }) => {
        const task = row.original;
        const done = task.status === 'COMPLETED';
        const overdue = new Date(task.dueDate) < new Date() && !done;
        return (
          <div>
            <p
              className={cn(
                'text-sm font-medium',
                done ? 'line-through text-muted-foreground' : 'text-foreground',
                overdue && !done && 'text-danger',
              )}
            >
              {task.title}
            </p>
            {/* Whose task it is. Embedded, this SELECTS — reading the person's
                conversation beside their task is the whole point of the view,
                and the surface's one rule is that clicking selects rather than
                navigates. On /tasks it stays the link it has always been. */}
            {task.lead &&
              (onSelectPerson ? (
                <button
                  type="button"
                  data-testid={`task-lead-${task.id}`}
                  aria-current={!!selectedLeadId && task.lead.id === selectedLeadId}
                  onClick={() => onSelectPerson(task.lead!)}
                  className="text-xs text-primary hover:underline aria-[current=true]:font-semibold"
                >
                  {task.lead.businessName}
                </button>
              ) : (
                <Link
                  to={`/leads/${task.lead.id}`}
                  className="text-xs text-primary hover:underline"
                >
                  {task.lead.businessName}
                </Link>
              ))}
          </div>
        );
      },
    },
    {
      accessorKey: 'type',
      header: t('tasks.table.type'),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={TYPE_TONE[val] ?? 'neutral'} size="sm">
            {t(`taskType.${val}`, { defaultValue: val.replace('_', ' ') })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'priority',
      header: t('tasks.table.priority'),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={PRIORITY_TONE[val] ?? 'neutral'} size="sm">
            {t(`priority.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('tasks.table.status'),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={STATUS_TONE[val] ?? 'neutral'} size="sm">
            {t(`taskStatus.${val}`, { defaultValue: val.replace('_', ' ') })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'dueDate',
      header: t('tasks.table.dueDate'),
      cell: ({ row }) => {
        const task = row.original;
        const overdue = new Date(task.dueDate) < new Date() && task.status !== 'COMPLETED';
        return (
          <span
            className={cn('text-sm', overdue ? 'text-danger font-medium' : 'text-muted-foreground')}
          >
            {fmtDateTime(task.dueDate)}
          </span>
        );
      },
    },
    {
      accessorKey: 'assignedTo',
      header: t('tasks.table.assignedTo'),
      // Not in the backend sort allow-list (and ordering by the rep object is
      // meaningless) — keep it a plain header so a click can't silently no-op.
      enableSorting: false,
      cell: ({ row }) => {
        const u = row.original.assignedTo;
        if (!u) return <span className="text-muted-foreground text-sm">—</span>;
        return (
          <span className="text-sm text-foreground">
            {u.firstName} {u.lastName}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const task = row.original;
        const done = task.status === 'COMPLETED';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions')} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {task.status === 'PENDING' && (
                <DropdownMenuItem
                  onClick={() => statusMutation.mutate({ id: task.id, status: 'IN_PROGRESS' })}
                >
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('taskStatus.IN_PROGRESS')}
                </DropdownMenuItem>
              )}
              {!done && (
                <DropdownMenuItem onClick={() => completeMutation.mutate(task.id)}>
                  <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('taskStatus.COMPLETED')}
                </DropdownMenuItem>
              )}
              {!done && (
                <DropdownMenuItem onClick={() => openEdit(task)}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('common.edit')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-danger focus:text-danger"
                onClick={() => setDeleteTarget(task)}
              >
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Page header */}
      {!embedded && (
        <PageHeader
          title={t('tasks.title')}
          description={t('tasks.subtitle')}
          actions={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('tasks.createButton')}
            </Button>
          }
        />
      )}

      {/* Filter / tab row */}
      <FilterBar>
        {/* Tab buttons */}
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          {TASK_TABS.map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors',
                tab === tabKey
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-surface-muted',
              )}
            >
              {tabKey === 'overdue' && (
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t(`tasks.tabs.${tabKey}`)}
            </button>
          ))}
        </div>

        {/* Creating a task is a CAPABILITY, so when the header goes it follows
            the list rather than disappearing with the chrome. */}
        {embedded && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('tasks.createButton')}
          </Button>
        )}

        {/* Status filter (only meaningful on "all" tab) */}
        {tab === 'all' && (
          <Select value={status || '__ALL__'} onValueChange={(v) => setStatus(v === '__ALL__' ? '' : v)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={t('tasks.filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__ALL__">{t('common.all')}</SelectItem>
              <SelectItem value="PENDING">{t('taskStatus.PENDING')}</SelectItem>
              <SelectItem value="IN_PROGRESS">{t('taskStatus.IN_PROGRESS')}</SelectItem>
              <SelectItem value="COMPLETED">{t('taskStatus.COMPLETED')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FilterBar>

      {/* Task table.

          A broken read and an empty queue are different screens, and this list
          did not tell them apart: it read only `isLoading`, so a failed /tasks
          fell through to the DataTable's empty state — "No tasks here." with a
          "New task" button under it. On a page that is somebody's work queue,
          and now a COLUMN of the person surface, that is the most expensive
          thing a list can lie about. */}
      <QueryStateBoundary
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('tasks.loadFailed', 'Could not load tasks.')}
        retryLabel={t('common.retry', 'Retry')}
      >
        <DataTable
          columns={columns}
          data={tasks}
          isLoading={isLoading}
          loadingRowCount={6}
          sorting={sorting}
          onSortingChange={setSorting}
          emptyState={
            <EmptyState
              icon={<ClipboardList className="h-10 w-10" />}
              title={t('tasks.empty')}
              description={t('tasks.emptyHint')}
              action={
                <Button onClick={openCreate} variant="outline">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('tasks.createButton')}
                </Button>
              }
            />
          }
        />
      </QueryStateBoundary>

      {/* Create / edit dialog */}
      <TaskFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        task={editingTask}
        onSubmit={handleFormSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
        reps={reps}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('common.delete') + ' ' + t('nav.tasks')}
        description={t('tasks.deleteDesc', 'This task will be permanently deleted. This cannot be undone.')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
