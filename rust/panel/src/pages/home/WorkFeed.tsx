import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pending as studioPending } from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { LedgerEntryOut, WorkItem } from '@/api/types';
import { Button, cn, SegmentedControl } from '@/components/ui';
import { workItemLink, workItemText, socialSlotId } from '@/lib/workItems';
import { ledgerModule, moduleTone } from './agenda';
import type { HomeCopy } from './copy';

type Tab = 'all' | 'pending' | 'log';
/** Kinds where a person decides, shown as approvals. */
const APPROVALS = new Set<WorkItem['kind']>(['ads_campaign_proposal', 'approve_strategy', 'campaign_approval', 'consult_strategy', 'studio_approval']);

interface Props {
  copy: HomeCopy;
  pending: WorkItem[] | undefined;
  log: LedgerEntryOut[] | undefined;
  /** False when the log could not be read (no permission, inactive workspace). */
  logAvailable: boolean;
  actorName: (entry: LedgerEntryOut) => string;
  moduleName: (id: string) => string;
  className?: string;
}

function clock(iso: string, language: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(language === 'tr' ? 'tr-TR' : 'en-GB',
    sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Pending work first (what needs someone), then the ledger as a running log. */
export function WorkFeed({ copy, pending, log, logAvailable, actorName, moduleName, className }: Props) {
  const { t } = useTranslation();
  const language = copy.isTurkish ? 'tr' : 'en';
  const [tab, setTab] = useState<Tab>('all');
  const items = [...(pending ?? [])].sort((a, b) => a.priority - b.priority);
  const session = useSession();
  const socialPending = useQuery({
    queryKey: ['studio', session.data?.current_workspace, 'pending'],
    queryFn: studioPending,
    enabled: can(session.data, 'social.work') && items.some(item => socialSlotId(item) !== null),
  });
  const tiktokSlots = new Set(socialPending.data?.blockers.filter(blocker => blocker.next_action === 'tiktok_posting_screen').flatMap(blocker => 'slot' in blocker.target ? [blocker.target.slot] : []));
  const showPending = tab !== 'log';
  const showLog = tab !== 'pending' && logAvailable;
  const shownPending = items;

  return <section aria-labelledby="home-work" className={cn('flex min-h-0 min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4', className)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="home-work" className="flex items-center gap-2 text-sm font-medium"><ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{copy('work')}
        {items.length > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs tabular-nums text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">{items.length}</span>}</h2>
      <SegmentedControl aria-label={copy('work')} value={tab} onChange={setTab}
        options={[{ value: 'all', label: copy('tabAll') }, { value: 'pending', label: copy('tabPending') }, ...(logAvailable ? [{ value: 'log' as const, label: copy('tabLog') }] : [])]} />
    </div>

    <div className="-me-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-2">
      {showPending && (shownPending.length === 0
        ? (tab === 'pending' || !showLog) && <p className="text-sm text-muted-foreground">{copy('noPending')}</p>
        : <ul className="flex flex-col gap-1.5" aria-label={copy('tabPending')}>
          {shownPending.map((item, i) => {
            const tiktokWaiting = tiktokSlots.has(socialSlotId(item) ?? '');
            const link = workItemLink(item, tiktokWaiting);
            const approval = APPROVALS.has(item.kind);
            return <li key={`${item.kind}-${i}`} className={cn('flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2',
              approval ? 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10' : 'border-border bg-surface-muted/40')}>
              <p className="min-w-0 flex-1 text-sm leading-5">{workItemText(t, item, tiktokWaiting)}</p>
              {link && <Button asChild size="sm" variant={approval ? 'primary' : 'outline'}><Link to={link}>{copy('open')}</Link></Button>}
            </li>;
          })}
        </ul>)}

      {showLog && (!log?.length ? <p className="text-sm text-muted-foreground">{copy('noLog')}</p>
        : <ol className="flex flex-col" aria-label={copy('tabLog')}>
          {log.map(row => {
            const module = ledgerModule(row.entry.action);
            const phrase = copy.action(row.entry.action, row.entry.payload);
            return <li key={row.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 border-b border-border/60 py-1.5 text-xs last:border-0">
              <time dateTime={row.entry.at} className="tabular-nums text-muted-foreground">{clock(row.entry.at, language)}</time>
              <span className="min-w-0">
                <span className="font-medium">{actorName(row)}</span>{' '}
                {phrase ?? <code className="text-[11px] text-muted-foreground">{row.entry.action}</code>}
                <span className="text-muted-foreground"> · <span className={cn('me-1 inline-block h-1.5 w-1.5 rounded-full align-middle', moduleTone(module).dot)} aria-hidden="true" />{module ? moduleName(module) : copy('workspace')}</span>
              </span>
            </li>;
          })}
        </ol>)}
    </div>

  </section>;
}
