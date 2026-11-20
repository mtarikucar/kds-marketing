import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import type { PostRow } from '@/api/postsPage';
import type { NeedKey, WakesOut } from '@/api/types';
import { AgentWakeLine } from '@/components/AgentWakeLine';
import { formatRelative } from '@/lib/format';
import { useAgentWakes } from '@/lib/wake';

type PageNeed = Extract<NeedKey, 'content' | 'social' | 'materials'>;
const NEEDS: readonly PageNeed[] = ['content', 'social', 'materials'];

/** The work each agent of the page has waiting, from the rows read (§2.9.4). */
export function waitingWork(rows: PostRow[]): Record<PageNeed, number> {
  return {
    content: rows.filter((r) => r.kind === 'content' && (r.status === 'preparing' || r.status === 'revising') && r.sub_state?.kind !== 'files_analysing' && r.sub_state?.kind !== 'starts').length,
    social: rows.filter((r) => r.status === 'scheduling').length,
    materials: rows.filter((r) => r.sub_state?.kind === 'files_analysing').length,
  };
}

/**
 * Of the needs with work waiting, the one whose agent is not at work wins (that is what the owner
 * should know); with every one at work, the first; `null` when nothing waits.
 */
export function pickPageNeed(data: WakesOut | undefined, counts: Record<PageNeed, number>): { need: PageNeed; waiting: number } | null {
  const waiting = NEEDS.filter((n) => counts[n] > 0 && data?.needs[n] && data.needs[n].state !== 'no_agent');
  if (!waiting.length) return null;
  const idle = waiting.find((n) => data!.needs[n].state !== 'working');
  const need = idle ?? waiting[0];
  return { need, waiting: counts[need] };
}

/** The one agent line under the subtitle (§2.9.4). */
export function AgentLine({ rows }: { rows: PostRow[] }) {
  const { t, i18n } = useTranslation();
  const wakes = useAgentWakes();
  const picked = pickPageNeed(wakes.data, waitingWork(rows));
  if (picked) return <AgentWakeLine need={picked.need} waiting={picked.waiting} />;
  const last = (wakes.data?.agents ?? [])
    .map((a) => a.last_seen_at)
    .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
    .sort()
    .at(-1);
  if (!last) return null;
  return (
    <p data-testid="agent-ran" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Bot aria-hidden="true" className="h-4 w-4 shrink-0" />
      {t('postsPage.agent.ran', { ago: formatRelative(last, i18n.language) })}
    </p>
  );
}
