import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useSearchParams, Link } from 'react-router-dom';
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

export default function TasksPage() {
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
  const [tab, setTab] = useState<'all' | 'today' | 'overdue'>(
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

  const { data, isLoading } = useQuery({
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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });

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
    const payload: Record<string, unknown> = {
      title: values.title,
      type: values.type,
      priority: values.priority,
      // Combine the local date + time into a full ISO datetime so the hour the
      // rep picked is exactly what gets stored (no off-by-one, no end-of-day).
      dueDate: localDateTimeToIso(values.dueDate, values.dueTime),
      ...(values.description ? { description: values.description } : {}),
      ...(values.leadId ? { leadId: values.leadId } : {}),
      ...(values.assignedToId ? { assignedToId: values.assignedToId } : {}),
    };

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
            {task.lead && (
              <Link
                to={`/leads/${task.lead.id}`}
                className="text-xs text-primary hover:underline"
              >
                {task.lead.businessName}
              </Link>
            )}
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

      {/* Filter / tab row */}
      <FilterBar>
        {/* Tab buttons */}
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          {(['all', 'today', 'overdue'] as const).map((tabKey) => (
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

      {/* Task table */}
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
