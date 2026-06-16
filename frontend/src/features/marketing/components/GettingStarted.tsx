import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle, ChevronRight, X } from 'lucide-react';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  IconButton,
  Progress,
} from '@/components/ui';

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
    queryFn: () =>
      marketingApi.get('/leads', { params: { limit: 1 } }).then((r) => r.data),
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
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t('onboarding.title')}</CardTitle>
            <CardDescription className="mt-1">{t('onboarding.subtitle')}</CardDescription>
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('onboarding.dismiss')}
            onClick={dismiss}
            className="shrink-0 -mt-1 -me-1"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {/* Progress bar */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t('onboarding.progress', { done, total })}
          </p>
          <Progress value={(done / total) * 100} tone="primary" />
        </div>

        {/* Step list */}
        <div className="space-y-1.5">
          {steps.map((s, i) => (
            <Link
              key={s.id}
              to={s.to}
              className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-surface-muted transition-colors"
            >
              {s.done ? (
                <CheckCircle className="w-6 h-6 shrink-0 text-success" />
              ) : (
                <span className="w-6 h-6 shrink-0 rounded-full border-2 border-border flex items-center justify-center text-xs font-semibold text-muted-foreground">
                  {i + 1}
                </span>
              )}
              <span className="flex-1 min-w-0">
                <span
                  className={`block font-medium text-sm ${
                    s.done ? 'text-muted-foreground line-through' : 'text-foreground'
                  }`}
                >
                  {t(`onboarding.steps.${s.id}.title`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(`onboarding.steps.${s.id}.desc`)}
                </span>
              </span>
              {!s.done && (
                <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
              )}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
