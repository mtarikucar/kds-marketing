import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoutineConfig {
  key: string;
  enabled: boolean;
  cron: string | null;
  onEvent: boolean;
  triggerUrl: string | null;
  hasToken: boolean;
  eventCooldownSec: number;
  lastTriggeredAt: string | null;
  lastTriggerStatus: string | null;
  lastTriggerError: string | null;
}

interface UpdateRoutineBody {
  enabled?: boolean;
  cron?: string | null;
  onEvent?: boolean;
  triggerUrl?: string | null;
  triggerToken?: string;
  eventCooldownSec?: number;
}

interface TriggerResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTINE_LABELS: Record<string, string> = {
  'review-draft': 'Review draft',
  'content-pack': 'Content pack',
  'insight-digest': 'Insight digest',
  'lead-scoring': 'Lead scoring',
};

/** Only these routines have meaningful event triggers. */
const EVENT_DRIVEN_KEYS = new Set(['review-draft', 'lead-scoring']);

const STATUS_BADGE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-red-50 text-red-700 border-red-200',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function extractMessage(e: unknown): string {
  const err = e as { response?: { data?: { message?: string } } };
  return err?.response?.data?.message ?? 'An error occurred';
}

// ─── RoutineCard ──────────────────────────────────────────────────────────────

interface RoutineCardProps {
  routine: RoutineConfig;
}

function RoutineCard({ routine }: RoutineCardProps) {
  const queryClient = useQueryClient();

  // Local form state — seeded from server data
  const [enabled, setEnabled] = useState(routine.enabled);
  const [onEvent, setOnEvent] = useState(routine.onEvent);
  const [cron, setCron] = useState(routine.cron ?? '');
  const [triggerUrl, setTriggerUrl] = useState(routine.triggerUrl ?? '');
  const [triggerToken, setTriggerToken] = useState('');
  const [cooldown, setCooldown] = useState(String(routine.eventCooldownSec));

  const saveMutation = useMutation({
    mutationFn: (body: UpdateRoutineBody) =>
      platformApi.patch(`/routines/${routine.key}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'routines'] });
      toast.success(`${ROUTINE_LABELS[routine.key] ?? routine.key} saved`);
      // Clear write-only token field after save
      setTriggerToken('');
    },
    onError: (e: unknown) => toast.error(extractMessage(e)),
  });

  const triggerMutation = useMutation({
    mutationFn: () =>
      platformApi.post<TriggerResult>(`/routines/${routine.key}/trigger`).then((r) => r.data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'routines'] });
      if (result.ok) {
        toast.success(`${ROUTINE_LABELS[routine.key] ?? routine.key} triggered`);
      } else if (result.skipped) {
        toast.warning(`Skipped — ${result.error ?? 'routine is disabled or in cooldown'}`);
      } else {
        toast.error(`Trigger failed: ${result.error ?? 'unknown error'}`);
      }
    },
    onError: (e: unknown) => toast.error(extractMessage(e)),
  });

  function handleSave() {
    const body: UpdateRoutineBody = {
      enabled,
      onEvent,
      cron: cron.trim() || null,
      triggerUrl: triggerUrl.trim() || null,
      eventCooldownSec: Number(cooldown) || 300,
    };
    if (triggerToken.trim()) {
      body.triggerToken = triggerToken.trim();
    }
    saveMutation.mutate(body);
  }

  const isEventDriven = EVENT_DRIVEN_KEYS.has(routine.key);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">
            {ROUTINE_LABELS[routine.key] ?? routine.key}
          </h3>
          <span className="text-xs text-slate-400 font-mono">{routine.key}</span>
        </div>

        {/* Last-run badge */}
        <div className="flex items-center gap-2 text-xs">
          {routine.lastTriggerStatus && (
            <span
              className={`inline-block px-2 py-0.5 rounded-full border font-medium ${STATUS_BADGE[routine.lastTriggerStatus] ?? 'bg-slate-100 text-slate-500 border-slate-200'}`}
            >
              {routine.lastTriggerStatus}
            </span>
          )}
          <span className="text-slate-400">{relativeTime(routine.lastTriggeredAt)}</span>
        </div>
      </div>

      {/* Last error */}
      {routine.lastTriggerError && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 font-mono break-all">
          {routine.lastTriggerError}
        </p>
      )}

      {/* Toggle row */}
      <div className="flex items-center gap-6 flex-wrap">
        {/* Enabled toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={`relative inline-flex h-5 w-9 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 ${enabled ? 'bg-slate-900' : 'bg-slate-300'}`}
          >
            <span
              className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
            />
          </button>
          <span className="text-sm text-slate-700">Enabled</span>
        </label>

        {/* onEvent toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <button
            type="button"
            role="switch"
            aria-checked={onEvent}
            onClick={() => setOnEvent((v) => !v)}
            className={`relative inline-flex h-5 w-9 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 ${onEvent ? 'bg-slate-900' : 'bg-slate-300'}`}
          >
            <span
              className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform ${onEvent ? 'translate-x-4' : 'translate-x-0.5'}`}
            />
          </button>
          <span className="text-sm text-slate-700">
            Trigger on event
            {!isEventDriven && (
              <span className="ml-1 text-xs text-slate-400">(no events for this routine)</span>
            )}
          </span>
        </label>
      </div>

      {/* Inputs grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Cron */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-600">
            Cron schedule
          </label>
          <input
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 3 * * *"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono outline-none focus:ring-2 focus:ring-slate-900"
          />
          <p className="text-xs text-slate-400">Leave blank = no schedule (manual / event only)</p>
        </div>

        {/* Event cooldown */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-slate-600">
            Event cooldown (seconds)
          </label>
          <input
            type="number"
            min={0}
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-900"
          />
          <p className="text-xs text-slate-400">Min seconds between event-driven triggers (debounce)</p>
        </div>

        {/* Trigger URL */}
        <div className="space-y-1 sm:col-span-2">
          <label className="block text-xs font-medium text-slate-600">
            Trigger URL
          </label>
          <input
            type="url"
            value={triggerUrl}
            onChange={(e) => setTriggerUrl(e.target.value)}
            placeholder="https://claude.ai/api/..."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>

        {/* Trigger Token */}
        <div className="space-y-1 sm:col-span-2">
          <label className="block text-xs font-medium text-slate-600">
            Trigger token
            <span className="ml-1 font-normal text-slate-400">(write-only)</span>
          </label>
          <input
            type="password"
            value={triggerToken}
            onChange={(e) => setTriggerToken(e.target.value)}
            placeholder={routine.hasToken ? 'configured — paste to replace' : 'paste token from claude.ai'}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-900"
          />
          <p className="text-xs text-slate-400">
            {routine.hasToken
              ? 'A token is already stored. Leave blank to keep it unchanged.'
              : 'No token stored yet. Requires MARKETING_SECRET_KEY to be set on the server.'}
          </p>
        </div>
      </div>

      {/* Action row */}
      <div className="flex items-center justify-between gap-3 pt-1 flex-wrap">
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="px-4 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </button>

        <button
          onClick={() => triggerMutation.mutate()}
          disabled={triggerMutation.isPending}
          className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
        >
          {triggerMutation.isPending ? 'Triggering…' : 'Trigger now'}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlatformRoutinesPage() {
  const { isAuthenticated, operator, logout } = usePlatformAuthStore();
  const navigate = useNavigate();

  const { data: routines, isLoading, isError } = useQuery<RoutineConfig[]>({
    queryKey: ['platform', 'routines'],
    queryFn: () => platformApi.get('/routines').then((r) => r.data),
    enabled: isAuthenticated,
  });

  // Guard AFTER all hooks (Rules of Hooks).
  if (!isAuthenticated) {
    return <Navigate to="/platform/login" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center font-bold">P</div>
            <h1 className="font-semibold">Platform Console</h1>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <button
              onClick={() => navigate('/platform/workspaces')}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              Workspaces
            </button>
            <button
              onClick={() => navigate('/platform/payments')}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              Payments
            </button>
            <span className="text-slate-300">{operator?.email}</span>
            <button
              onClick={() => logout()}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <h2 className="text-xl font-bold text-slate-900">Routines</h2>

        {isLoading && (
          <p className="text-slate-400 text-sm">Loading routines…</p>
        )}

        {isError && (
          <p className="text-red-600 text-sm">Failed to load routines. Check your session and try again.</p>
        )}

        {!isLoading && !isError && routines && (
          <div className="space-y-4">
            {routines.map((routine) => (
              <RoutineCard key={routine.key} routine={routine} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
