import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plus } from 'lucide-react';
import { useSession } from '@/auth/useSession';
import { agentIdle, useModuleAgents } from '@/components/ModuleStatusLine';
import { QueryState } from '@/components/QueryState';
import { Button, EmptyState } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { PoolHeader, tabClass } from './prospects/PoolHeader';
import { Composer } from './research/Composer';
import { useTaskCopy } from './research/copy';
import { useAllTasks, useOpenTasks, useSegmentNames } from './research/data';
import { TaskRow } from './research/TaskRow';
import type { ListedTask } from '@/api/types';

type Filter = 'open' | 'closed';

/**
 * Said once, when it matters: open tasks may still record today and no agent that may research
 * checked in on time (the content page's rule, `agentIdle`). Nothing otherwise.
 */
function IdleLine({ open }: { open: ListedTask[] }) {
  const copy = useTaskCopy();
  const { candidates } = useModuleAgents('prospects');
  const waiting = open.filter((x) => x.remaining_today > 0).length;
  const idle = candidates ? agentIdle(waiting, candidates) : null;
  if (!idle) return null;
  const text = idle.last
    ? copy('idleOverdue', { n: waiting, time: formatDateTime(idle.last, copy.language) })
    : copy('idleNoAgent', { n: waiting });
  return (
    <p role="status" className="flex items-center gap-2 border-s-2 border-warning bg-warning-subtle px-4 py-2 text-sm">
      <Bot aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <Link className="min-w-0 underline underline-offset-4" to="/agents">{text}</Link>
    </p>
  );
}

/**
 * `/prospects/tasks`: the prospect pool's research tasks as one list (owner decision
 * 2026-11-19, the content and social pages' sibling). A row reads at a glance (what it looks
 * for and where, what it found, today's pace, who is on it) and opens in place for the whole
 * brief, the newest prospects, the claim and closing; counted chips filter open and closed
 * tasks; a new one-off task is two fields and a sentence, the rest folded away.
 */
export function ResearchTasksPage() {
  const copy = useTaskCopy();
  const session = useSession();
  const segments = useSegmentNames();
  const openTasks = useOpenTasks();
  const allTasks = useAllTasks();
  const [filter, setFilter] = useState<Filter>('open');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const open = openTasks.data?.items ?? [];
  const closed = (allTasks.data?.pages ?? []).flatMap((p) => p.items).filter((x) => x.task.status !== 'open');
  const moreClosed = allTasks.hasNextPage;
  const shown = filter === 'open' ? open : closed;
  const nothingAtAll = openTasks.isSuccess && allTasks.isSuccess && open.length === 0 && closed.length === 0;
  const chips: { key: Filter; label: string; count: string }[] = [
    { key: 'open', label: copy('open'), count: openTasks.data ? String(open.length) : '' },
    { key: 'closed', label: copy('closed'), count: allTasks.data ? `${closed.length}${moreClosed ? '+' : ''}` : '' },
  ];
  const query = filter === 'open' ? openTasks : allTasks;
  return (
    <>
      <PoolHeader
        framed
        actions={
          <Button size="sm" aria-expanded={composing} aria-controls="research-composer" onClick={() => setComposing((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy('newTask')}
          </Button>
        }
      />
      {composing && (
        <div id="research-composer">
          <Composer
            tasks={open.map((x) => x.task)}
            segments={segments}
            onDone={(created) => {
              setComposing(false);
              if (created) {
                setFilter('open');
                setExpanded(created);
              }
            }}
          />
        </div>
      )}
      <IdleLine open={open} />
      {nothingAtAll ? (
        <EmptyState title={copy('emptyTitle')} description={copy('emptyBody')} />
      ) : (
        <section aria-label={copy('listLabel')} className="min-w-0 space-y-3">
          <div role="group" aria-label={copy('filterLabel')} className="flex flex-wrap gap-0.5">
            {chips.map((chip) => (
              <button key={chip.key} type="button" aria-pressed={filter === chip.key} onClick={() => setFilter(chip.key)} className={tabClass(filter === chip.key)}>
                {chip.label}
                {chip.count && <> <span className="ms-0.5 font-mono text-xs tabular-nums">{chip.count}</span></>}
              </button>
            ))}
          </div>
          <QueryState query={query}>
            {shown.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                {copy(filter === 'open' ? 'noOpen' : 'noClosed')}
              </p>
            ) : (
              <div className="min-w-0 space-y-2">
                {shown.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    item={item}
                    segments={segments}
                    userId={session.data?.user_id}
                    expanded={expanded === item.task.id}
                    onToggle={() => setExpanded((id) => (id === item.task.id ? null : item.task.id))}
                  />
                ))}
              </div>
            )}
            {filter === 'closed' && moreClosed && (
              <Button variant="outline" size="sm" loading={allTasks.isFetchingNextPage} onClick={() => void allTasks.fetchNextPage()}>
                {copy('moreClosed')}
              </Button>
            )}
          </QueryState>
        </section>
      )}
    </>
  );
}
