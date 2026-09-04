import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Gauge, Check, AlertTriangle, Circle, Bot } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';
import marketingApi from '../api/marketingApi';

export type ReadinessState = 'READY' | 'MISSING' | 'ATTENTION';

export interface ReadinessItem {
  id: string;
  group: string;
  state: ReadinessState;
  to: string;
  mcpTool: string | null;
  detail?: Record<string, number | string | boolean>;
}

interface Readiness {
  items: ReadinessItem[];
  ready: number;
  total: number;
  attention: number;
}

export const READINESS_QUERY_KEY = ['marketing', 'readiness'] as const;

/** The order the groups are worked through, and the order they read in. */
const GROUPS = ['identity', 'plan', 'reach', 'content', 'selling', 'pages', 'fuel'] as const;

/**
 * What this workspace still needs, beside the notification bell.
 *
 * ── WHY IT IS NOT THE FIRST-RUN GUIDE ───────────────────────────────────────
 *
 * `GettingStarted` asks "have you done the four things only a person can do?"
 * and is dismissible, because it is finished once. This asks a standing
 * question — "is the engine fully fuelled?" — whose answer changes on its own:
 * a token expires, a wallet empties, a campaign is paused, and the machine
 * quietly does less than it did last week. That is why it lives in the chrome
 * rather than on a page: nothing else in the product tells you when a
 * capability turns off.
 *
 * ── WHY IT DOES NOT NAG ─────────────────────────────────────────────────────
 *
 * No badge when everything is ready, and the badge counts only what is actually
 * wrong. A permanent number beside the bell is a number people stop seeing, and
 * this one has to still mean something on the day an account breaks.
 */
export function SetupReadinessButton() {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);

  const { data } = useQuery<Readiness>({
    queryKey: READINESS_QUERY_KEY,
    queryFn: () => marketingApi.get('/onboarding/readiness').then((r) => r.data),
    staleTime: 60_000,
  });

  /**
   * Renders nothing rather than trusting the shape.
   *
   * This sits in the app chrome, beside the notification bell, and a throw here
   * does not degrade one panel — it takes the whole header down: no navigation,
   * no search, no profile menu. The shapes that reach it are not hypothetical:
   * an older backend during a rolling deploy, a proxy's HTML error page, a
   * 204 with no body. None of those is worth the header.
   */
  const items = Array.isArray(data?.items) ? data.items : null;
  if (!items) return null;
  const total = items.length;
  const ready = items.filter((i) => i.state === 'READY').length;
  const attention = items.filter((i) => i.state === 'ATTENTION').length;
  const gaps = total - ready;
  const allReady = gaps === 0;

  const stateIcon = (s: ReadinessState) =>
    s === 'READY' ? (
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
    ) : s === 'ATTENTION' ? (
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
    ) : (
      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          aria-label={t('readiness.title', { defaultValue: 'Setup readiness' })}
          variant="ghost"
          className="relative"
        >
          <Gauge className="h-5 w-5" />
          {gaps > 0 && (
            <Badge
              tone={attention > 0 ? 'danger' : 'warning'}
              size="sm"
              className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] justify-center px-1 text-[10px] font-bold"
            >
              {gaps}
            </Badge>
          )}
        </IconButton>
      </PopoverTrigger>

      <PopoverContent align="end" className="flex max-h-[32rem] w-96 flex-col p-0">
        <div className="border-b border-border px-4 py-3">
          <p className="font-medium text-foreground">
            {t('readiness.title', { defaultValue: 'Setup readiness' })}
          </p>
          {/*
            Said plainly, and only when it is true. An engine missing its inputs
            does not fail — it under-performs quietly, which is the failure
            nobody reports and nobody can see from any other screen.
          */}
          <p className="mt-0.5 text-caption text-muted-foreground">
            {allReady
              ? t('readiness.allDone', {
                  count: total,
                  defaultValue: 'All {{count}} are in place. The engine is running at full strength.',
                })
              : t('readiness.subtitle', {
                  ready,
                  total,
                  defaultValue:
                    '{{ready}} of {{total}} in place. Until the rest are, parts of the system run at reduced strength or not at all.',
                })}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {GROUPS.map((g) => {
            const inGroup = items.filter((i) => i.group === g);
            if (!inGroup.length) return null;
            return (
              <div key={g} className="border-b border-border last:border-b-0">
                <p className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t(`readiness.group.${g}`, { defaultValue: g })}
                </p>
                <ul className="pb-2">
                  {inGroup.map((i) => (
                    <li key={i.id}>
                      <Link
                        to={i.to}
                        onClick={() => setOpen(false)}
                        className={cn(
                          'flex gap-2.5 px-4 py-2 text-sm transition-colors hover:bg-surface-muted',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        )}
                      >
                        {stateIcon(i.state)}
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              'block',
                              i.state === 'READY' ? 'text-muted-foreground' : 'text-foreground',
                            )}
                          >
                            {t(`readiness.item.${i.id}.label`, { defaultValue: i.id })}
                          </span>
                          {i.state !== 'READY' && (
                            <span className="block text-caption text-muted-foreground">
                              {t(`readiness.item.${i.id}.why`, { defaultValue: '' })}
                            </span>
                          )}
                        </span>
                        {/*
                          The one thing that turns this from a list of
                          complaints into something that can be handed over:
                          which of these the connected Claude can finish on its
                          own. Absent on the ones it must not touch — a payment
                          key belongs to the person who holds it.
                        */}
                        {i.state !== 'READY' && i.mcpTool && (
                          <Bot
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label={t('readiness.mcpCanDo', {
                              defaultValue: 'Your connected Claude can do this',
                            })}
                          />
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {!allReady && (
          <div className="border-t border-border px-4 py-3">
            <p className="text-caption text-muted-foreground">
              {t('readiness.askClaude', {
                defaultValue:
                  'Marked with a robot: ask your connected Claude to “finish setting up this workspace” and it can close those itself.',
              })}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default SetupReadinessButton;
