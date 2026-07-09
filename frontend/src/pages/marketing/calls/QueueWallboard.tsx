import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Users, Clock, PhoneIncoming, Info, Coffee, CheckCircle2 } from 'lucide-react';
import {
  getQueueStats,
  setAgentPresence,
  type QueueAgentState,
  type AgentPresenceState,
} from '../../../features/marketing/api/telephony-queue.service';
import { fmtDuration } from '../../../features/marketing/utils/format';
import {
  Card,
  CardContent,
  Badge,
  type BadgeProps,
  Button,
  Spinner,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '../../../components/ui';

const AGENT_STATE_TONE: Record<QueueAgentState, BadgeProps['tone']> = {
  available: 'success',
  paused: 'warning',
  oncall: 'info',
  offline: 'neutral',
  unknown: 'neutral',
};

const BREAK_REASON_KEYS = ['reasonLunch', 'reasonMeeting', 'reasonTechnical', 'reasonOther'] as const;

/** English fallback labels for the preset reason chips (i18next default when a locale is missing the key). */
const BREAK_REASON_FALLBACK: Record<(typeof BREAK_REASON_KEYS)[number], string> = {
  reasonLunch: 'Lunch',
  reasonMeeting: 'Meeting',
  reasonTechnical: 'Technical issue',
  reasonOther: 'Other',
};

const QUEUE_STATS_KEY = ['marketing', 'telephony', 'queues', 'stats'] as const;

function errMsg(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Live queue wallboard + rep available/break toggle (NetGSM Phase 4 Task 4).
 * Polls `GET /telephony/queues/stats` every ~10s — cheap enough for a
 * dashboard widget, frequent enough to feel "live" without hammering the
 * crmsntrl host. The presence toggle always acts on the CALLING rep's own
 * extension (the server resolves it, never a value this component sends) —
 * a rep with no extension configured yet gets the backend's own 400 message
 * surfaced as a toast rather than the control being hidden client-side.
 *
 * Self-contained: mount only where the workspace is telephony-entitled (the
 * caller gates that — see CallsPage), since the underlying routes 503 for a
 * workspace with no active Netsantral config.
 */
export default function QueueWallboard() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [showBreakDialog, setShowBreakDialog] = useState(false);
  const [reason, setReason] = useState('');
  // Optimistic local read of "my" last-set presence — queuestats' wire shape
  // doesn't reliably let us pick "which agent row is me" (bare extension vs
  // sipUsername ambiguity), so this reflects only what THIS tab just set.
  const [myPresence, setMyPresence] = useState<AgentPresenceState | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: QUEUE_STATS_KEY,
    queryFn: getQueueStats,
    refetchInterval: 10_000,
    retry: false,
  });

  const presenceMutation = useMutation({
    mutationFn: setAgentPresence,
    onSuccess: (res) => {
      setMyPresence(res.state);
      toast.success(
        res.state === 'available'
          ? t('queueWallboard.presence.toggleSuccessAvailable', "You're available")
          : t('queueWallboard.presence.toggleSuccessBreak', "You're on a break"),
      );
      setShowBreakDialog(false);
      setReason('');
      qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY });
    },
    onError: (e: any) =>
      toast.error(errMsg(e, t('queueWallboard.presence.toggleFailed', 'Could not update your status'))),
  });

  const queues = data?.queues ?? [];

  const totalWaiting = useMemo(() => queues.reduce((sum, q) => sum + q.waiting, 0), [queues]);

  const avgHoldtimeSec = useMemo(() => {
    const withHold = queues.filter((q) => q.holdtimeSec != null);
    if (!withHold.length) return null;
    return Math.round(withHold.reduce((sum, q) => sum + (q.holdtimeSec ?? 0), 0) / withHold.length);
  }, [queues]);

  const agents = useMemo(() => {
    const seen = new Map<string, QueueAgentState>();
    for (const q of queues) {
      for (const a of q.agents) {
        if (!seen.has(a.dahili)) seen.set(a.dahili, a.state);
      }
    }
    return Array.from(seen.entries()).map(([dahili, state]) => ({ dahili, state }));
  }, [queues]);

  const stateLabel = (s: QueueAgentState) => t(`queueWallboard.state.${s}`, s);

  if (isError) {
    return (
      <Card>
        <CardContent className="py-4 text-caption text-muted-foreground">
          {t('queueWallboard.loadError', 'Could not load queue stats.')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-body font-semibold text-foreground">
              {t('queueWallboard.title', 'Queue wallboard')}
            </h3>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('queueWallboard.helpTitle', 'About queues')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {t(
                    'queueWallboard.helpBody',
                    'Only teammates added to the queue as DYNAMIC members show live state here and can be managed with the toggle below — members added as STATIC in the NetGSM portal are read-only. Queue names follow the `{santral}-queue-{name}` pattern.',
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={myPresence === 'break' ? 'outline' : 'primary'}
              disabled={presenceMutation.isPending}
              onClick={() => presenceMutation.mutate({ state: 'available' })}
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('queueWallboard.presence.available', 'Available')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={myPresence === 'break' ? 'primary' : 'outline'}
              disabled={presenceMutation.isPending}
              onClick={() => setShowBreakDialog(true)}
            >
              <Coffee className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('queueWallboard.presence.break', 'Break')}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            <Spinner className="h-4 w-4" />
          </div>
        ) : queues.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            {t(
              'queueWallboard.noData',
              'No active queue yet — configure NetGSM Netsantral queues to see live stats here.',
            )}
          </p>
        ) : (
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <PhoneIncoming className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-caption text-muted-foreground">
                {t('queueWallboard.waiting', 'Waiting')}
              </span>
              <span className="text-body font-semibold text-foreground">{totalWaiting}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-caption text-muted-foreground">
                {t('queueWallboard.avgHoldtime', 'Avg hold time')}
              </span>
              <span className="text-body font-semibold text-foreground">
                {avgHoldtimeSec != null ? fmtDuration(avgHoldtimeSec) : '—'}
              </span>
            </div>
            {agents.length > 0 && (
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-caption text-muted-foreground">
                  {t('queueWallboard.agents', 'Agents')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {agents.map((a) => (
                    <Badge key={a.dahili} tone={AGENT_STATE_TONE[a.state]}>
                      {a.dahili} · {stateLabel(a.state)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={showBreakDialog} onOpenChange={setShowBreakDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('queueWallboard.presence.reasonTitle', 'Take a break')}</DialogTitle>
            <DialogDescription>
              {t(
                'queueWallboard.presence.reasonHint',
                "Optionally pick a reason — your manager sees it on the wallboard.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-1.5">
            {BREAK_REASON_KEYS.map((k) => {
              const label = t(`queueWallboard.presence.${k}`, BREAK_REASON_FALLBACK[k]);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setReason(label)}
                  className={`rounded-full border px-3 py-1 text-caption ${
                    reason === label
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('queueWallboard.presence.reasonPlaceholder', 'Reason (optional)')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-caption text-foreground"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowBreakDialog(false)}>
              {t('queueWallboard.presence.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              disabled={presenceMutation.isPending}
              onClick={() => presenceMutation.mutate({ state: 'break', reason: reason || undefined })}
            >
              {t('queueWallboard.presence.confirm', 'Start break')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
