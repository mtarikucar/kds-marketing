import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircleIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

const DISMISS_PREFIX = 'marketing:onboarding:dismissed:';

function readDismissed(ws: string): boolean {
  try {
    return localStorage.getItem(DISMISS_PREFIX + ws) === '1';
  } catch {
    return false; // Safari private mode etc. — treat as not-dismissed
  }
}
function writeDismissed(ws: string): void {
  try {
    localStorage.setItem(DISMISS_PREFIX + ws, '1');
  } catch {
    /* ignore — best effort */
  }
}

/**
 * Manager-only first-run checklist on the dashboard. Self-fetches each setup
 * area's list (reusing the AI pages' exact query keys, so the data is shared —
 * no duplicate fetches) and marks a step done when that area has ≥1 item.
 * Dismissible, and auto-hides once every step is complete; both states latch
 * per-workspace in localStorage so a configured workspace is never nagged.
 */
export default function GettingStarted() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const workspaceId = user?.workspaceId ?? 'unknown';
  const [dismissed, setDismissed] = useState(() => readDismissed(workspaceId));
  const active = isManager && !dismissed;

  const agents = useQuery<any[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
    enabled: active,
  });
  const docs = useQuery<any[]>({
    queryKey: ['marketing', 'ai', 'knowledge'],
    queryFn: () => marketingApi.get('/ai/knowledge').then((r) => r.data),
    enabled: active,
  });
  const channels = useQuery<any[]>({
    queryKey: ['marketing', 'channels'],
    queryFn: () => marketingApi.get('/channels').then((r) => r.data),
    enabled: active,
  });
  const sites = useQuery<any[]>({
    queryKey: ['marketing', 'sites'],
    queryFn: () => marketingApi.get('/sites').then((r) => r.data),
    enabled: active,
  });
  const leads = useQuery<{ meta?: { total?: number } }>({
    queryKey: ['marketing', 'leads', 'onboarding-count'],
    queryFn: () => marketingApi.get('/leads', { params: { limit: 1 } }).then((r) => r.data),
    enabled: active,
    staleTime: 60_000,
  });

  const steps = [
    { id: 'agent', to: '/ai/agents', done: (agents.data?.length ?? 0) > 0 },
    { id: 'knowledge', to: '/ai/knowledge', done: (docs.data?.length ?? 0) > 0 },
    { id: 'channel', to: '/channels', done: (channels.data?.length ?? 0) > 0 },
    { id: 'leads', to: '/leads', done: (leads.data?.meta?.total ?? 0) > 0 },
    { id: 'site', to: '/sites', done: (sites.data?.length ?? 0) > 0 },
  ];
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const allDone = done === total;

  // Latch dismissal once fully set up, so it stays gone on reload even if a
  // setup item is later removed.
  useEffect(() => {
    if (active && allDone) {
      writeDismissed(workspaceId);
      setDismissed(true);
    }
  }, [active, allDone, workspaceId]);

  if (!active || allDone) return null;

  const dismiss = () => {
    writeDismissed(workspaceId);
    setDismissed(true);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{t('onboarding.title')}</h2>
          <p className="text-sm text-slate-500">{t('onboarding.subtitle')}</p>
        </div>
        <button
          onClick={dismiss}
          title={t('onboarding.dismiss')}
          className="p-1.5 -mr-1 shrink-0 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-slate-500">{t('onboarding.progress', { done, total })}</p>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${(done / total) * 100}%` }} />
        </div>
      </div>

      <div className="space-y-1.5">
        {steps.map((s, i) => (
          <Link
            key={s.id}
            to={s.to}
            className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors"
          >
            {s.done ? (
              <CheckCircleIcon className="w-6 h-6 shrink-0 text-emerald-500" />
            ) : (
              <span className="w-6 h-6 shrink-0 rounded-full border-2 border-slate-200 flex items-center justify-center text-xs font-semibold text-slate-400">
                {i + 1}
              </span>
            )}
            <span className="flex-1 min-w-0">
              <span className={`block font-medium ${s.done ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                {t(`onboarding.steps.${s.id}.title`)}
              </span>
              <span className="block text-xs text-slate-500">{t(`onboarding.steps.${s.id}.desc`)}</span>
            </span>
            {!s.done && <ChevronRightIcon className="w-4 h-4 shrink-0 text-slate-300" />}
          </Link>
        ))}
      </div>
    </div>
  );
}
