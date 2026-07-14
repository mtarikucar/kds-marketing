import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import {
  InstallationStatus,
  INSTALLATION_STATUS_LABELS,
  INSTALLATION_TRANSITIONS,
} from '../../../features/marketing/types';
import type { InstallationJob, InstallationCrew } from '../../../features/marketing/types';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Badge,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
  Skeleton,
  ConfirmDialog,
} from '../../../components/ui';
import type { BadgeProps } from '../../../components/ui/Badge';

const WINDOWS = ['MORNING', 'AFTERNOON', 'FULL_DAY'] as const;

// Irreversible / negative transitions get a confirm: the status machine has NO
// path back to an active state from CANCELLED, and NO_SHOW only leads to
// CANCELLED — so a stray click on either permanently closes a booked
// installation with no UI recovery.
const CONFIRM_TRANSITIONS = new Set<string>([
  InstallationStatus.CANCELLED,
  InstallationStatus.NO_SHOW,
]);
const errMsg = (err: any, fallback: string) =>
  err?.response?.data?.message || fallback;

function statusTone(status: string): NonNullable<BadgeProps['tone']> {
  switch (status) {
    case 'REQUESTED':   return 'neutral';
    case 'SCHEDULED':   return 'info';
    case 'IN_PROGRESS': return 'warning';
    case 'DONE':        return 'success';
    case 'CANCELLED':   return 'danger';
    case 'NO_SHOW':     return 'danger';
    default:            return 'neutral';
  }
}

interface Props {
  jobId: string | null;
  crews: InstallationCrew[];
  onClose: () => void;
  onChanged: () => void;
}

export function JobDrawer({ jobId, crews, onClose, onChanged }: Props) {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();

  const [schedCrew, setSchedCrew] = useState('');
  const [schedDate, setSchedDate] = useState('');
  const [schedWindow, setSchedWindow] = useState('');
  const [newTask, setNewTask] = useState('');
  const [confirmStatus, setConfirmStatus] = useState<InstallationStatus | null>(null);

  // Reset the schedule form + new-task input whenever the opened job changes.
  // The parent mounts this drawer persistently (jobId is a prop, not a mount
  // gate), so without this a crew/date/window picked — or a task typed — for one
  // job would carry into the next and could be submitted against the wrong job
  // (e.g. dispatching job A's crew/date onto job B).
  useEffect(() => {
    setSchedCrew('');
    setSchedDate('');
    setSchedWindow('');
    setNewTask('');
  }, [jobId]);

  const { data: job, isLoading } = useQuery<InstallationJob>({
    queryKey: ['marketing', 'installations', 'job', jobId],
    queryFn: () => marketingApi.get(`/installations/jobs/${jobId}`).then((r) => r.data),
    enabled: !!jobId,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'installations', 'job', jobId] });
    onChanged();
  };

  const schedule = useMutation({
    mutationFn: () =>
      marketingApi.post(`/installations/jobs/${jobId}/schedule`, {
        crewId: schedCrew,
        scheduledDate: schedDate,
        scheduledWindow: schedWindow || undefined,
      }),
    onSuccess: () => { toast.success('Job scheduled'); refresh(); },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to schedule')),
  });

  const setStatus = useMutation({
    mutationFn: (s: string) =>
      marketingApi.patch(`/installations/jobs/${jobId}/status`, { status: s }),
    onSuccess: () => { toast.success('Status updated'); setConfirmStatus(null); refresh(); },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to update status')),
  });

  const addTask = useMutation({
    mutationFn: (title: string) =>
      marketingApi.post(`/installations/jobs/${jobId}/tasks`, { title }),
    onSuccess: () => { setNewTask(''); refresh(); },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to add task')),
  });

  const toggleTask = useMutation({
    mutationFn: (taskId: string) =>
      marketingApi.patch(`/installations/jobs/${jobId}/tasks/${taskId}/toggle`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(errMsg(e, 'Failed')),
  });

  const deleteTask = useMutation({
    mutationFn: (taskId: string) =>
      marketingApi.delete(`/installations/jobs/${jobId}/tasks/${taskId}`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(errMsg(e, 'Failed')),
  });

  const transitions = job ? (INSTALLATION_TRANSITIONS[job.status] || []) : [];

  return (
    <Sheet open={!!jobId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Installation Job</SheetTitle>
          <SheetDescription className="sr-only">Installation job details and status management</SheetDescription>
        </SheetHeader>

        {isLoading || !job ? (
          <div className="space-y-3 mt-4">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-36" />
          </div>
        ) : (
          <div className="space-y-5 mt-4">
            {/* Job info */}
            <div className="space-y-1">
              <Badge tone={statusTone(job.status)}>
                {INSTALLATION_STATUS_LABELS[job.status as InstallationStatus] || job.status}
              </Badge>
              <p className="font-medium text-foreground mt-2">{job.contactName || '—'}</p>
              <p className="text-sm text-muted-foreground">
                {[job.siteAddress, job.siteCity].filter(Boolean).join(', ') || 'No address'}
              </p>
              {job.contactPhone && (
                <p className="text-sm text-muted-foreground">{job.contactPhone}</p>
              )}
              {job.notes && (
                <p className="text-sm text-foreground mt-2">{job.notes}</p>
              )}
            </div>

            {/* Schedule / reschedule — the backend allows scheduling from
                REQUESTED, SCHEDULED and NO_SHOW (SCHEDULABLE_FROM), so a job put
                on the wrong crew/date, or a no-show that needs re-booking, can be
                fixed here instead of being stranded. */}
            {[InstallationStatus.REQUESTED, InstallationStatus.SCHEDULED, InstallationStatus.NO_SHOW].includes(
              job.status,
            ) && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <p className="text-sm font-semibold text-foreground">
                  {job.status === InstallationStatus.REQUESTED ? 'Schedule' : 'Reschedule'}
                </p>
                <Select value={schedCrew} onValueChange={setSchedCrew}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select crew…" />
                  </SelectTrigger>
                  <SelectContent>
                    {crews.filter((c) => c.active).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} (cap {c.dailyCapacity}/day)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  value={schedDate}
                  onChange={(e) => setSchedDate(e.target.value)}
                />
                <Select value={schedWindow} onValueChange={setSchedWindow}>
                  <SelectTrigger>
                    <SelectValue placeholder="Any window" />
                  </SelectTrigger>
                  <SelectContent>
                    {WINDOWS.map((w) => (
                      <SelectItem key={w} value={w}>
                        {w}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  className="w-full"
                  onClick={() => {
                    if (!schedCrew || !schedDate) {
                      toast.error('Crew and date are required');
                      return;
                    }
                    schedule.mutate();
                  }}
                  loading={schedule.isPending}
                >
                  Schedule
                </Button>
              </div>
            )}

            {/* Status state-machine transitions */}
            {transitions.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">Move to</p>
                <div className="flex flex-wrap gap-2">
                  {transitions.map((s) => (
                    <Button
                      key={s}
                      variant="outline"
                      size="sm"
                      // Terminal/negative moves confirm first; the rest fire
                      // directly. Loading is scoped to the clicked target so one
                      // transition doesn't spin every button.
                      onClick={() =>
                        CONFIRM_TRANSITIONS.has(s) ? setConfirmStatus(s) : setStatus.mutate(s)
                      }
                      loading={setStatus.isPending && setStatus.variables === s}
                    >
                      {INSTALLATION_STATUS_LABELS[s]}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* Task checklist */}
            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">Checklist</p>
              <div className="space-y-1">
                {job.tasks.length === 0 && (
                  <p className="text-sm text-muted-foreground">No tasks yet</p>
                )}
                {[...job.tasks]
                  .sort((a, b) => a.position - b.position)
                  .map((t) => (
                    <div key={t.id} className="flex items-center gap-2 group">
                      <input
                        type="checkbox"
                        checked={t.done}
                        onChange={() => toggleTask.mutate(t.id)}
                        className="rounded border-border-strong"
                      />
                      <span
                        className={`flex-1 text-sm ${
                          t.done ? 'line-through text-muted-foreground' : 'text-foreground'
                        }`}
                      >
                        {t.title}
                      </span>
                      <button
                        onClick={() => deleteTask.mutate(t.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-danger transition-opacity"
                        aria-label="Delete task"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => {
                    // Mirror the Add button's disabled guard (incl. !isPending):
                    // without it, Enter-spam adds the same task twice while the
                    // first POST is still in flight.
                    if (e.key === 'Enter' && newTask.trim() && !addTask.isPending) addTask.mutate(newTask.trim());
                  }}
                  placeholder="Add task…"
                />
                <Button
                  variant="secondary"
                  onClick={() => newTask.trim() && addTask.mutate(newTask.trim())}
                  disabled={!newTask.trim() || addTask.isPending}
                >
                  Add
                </Button>
              </div>
            </div>

            {!isManager && (
              <p className="text-xs text-muted-foreground">
                Crew and job creation are manager-only.
              </p>
            )}
          </div>
        )}
      </SheetContent>

      <ConfirmDialog
        open={confirmStatus !== null}
        onOpenChange={(o) => { if (!o) setConfirmStatus(null); }}
        title={
          confirmStatus === InstallationStatus.NO_SHOW
            ? 'Mark this installation as a no-show?'
            : 'Cancel this installation?'
        }
        description={
          confirmStatus === InstallationStatus.NO_SHOW
            ? 'Records the customer as a no-show. It can only be moved to Cancelled afterwards — there is no path back to an active state.'
            : 'Cancels the scheduled installation. It cannot be moved back to an active state.'
        }
        confirmLabel={
          confirmStatus === InstallationStatus.NO_SHOW ? 'Mark no-show' : 'Cancel installation'
        }
        tone="danger"
        loading={setStatus.isPending}
        onConfirm={() => confirmStatus && setStatus.mutate(confirmStatus)}
      />
    </Sheet>
  );
}
