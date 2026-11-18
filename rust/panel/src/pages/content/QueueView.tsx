import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bot, Inbox } from 'lucide-react';
import { analysisQueue, GENEL, type QueueItem, type QueueStage, type TreeOut } from '@/api/content';
import * as m from '@/api/materials';
import { getPending } from '@/api/work';
import { useSession } from '@/auth/useSession';
import { Badge, Button, EmptyState } from '@/components/ui';
import { agentNotice } from '@/components/ModuleStatusLine';
import { QueryState } from '@/components/QueryState';
import { fieldClass, MaterialPreview, materialLabel, MaterialsError, useDecider, useMaterialsMutation } from '../materials/MaterialsShared';
import { placeHref, useContentKey, useContentPlace } from './location';

const TONE: Record<QueueStage, 'neutral' | 'info' | 'warning' | 'danger'> = {
  waiting: 'neutral',
  analysing: 'info',
  needs_filing: 'warning',
  failed: 'danger',
};

/** A person files an analysed upload nobody filed: an olay of the tree, or Genel (`studio.material_bind`). */
function FileInto({ item, tree }: { item: QueueItem; tree: TreeOut }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState('');
  const bind = useMaterialsMutation(() =>
    m.materialBind(item.material.id, item.material.revision, target === GENEL ? { kind: 'genel' } : { kind: 'olay', olay_id: target }),
  );
  const label = `${t('content.queue.fileInto')} · ${materialLabel(t, item.material)}`;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (target && !bind.isPending) bind.mutate(undefined);
      }}
    >
      <select aria-label={label} className={`${fieldClass} w-auto min-w-[12rem] flex-1`} value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{t('content.queue.choose')}</option>
        {tree.olays.map((o) => <option key={o.olay.id} value={o.olay.id}>{o.olay.title}</option>)}
        <option value={GENEL}>{t('content.genel')}</option>
      </select>
      <Button type="submit" size="sm" disabled={!target} loading={bind.isPending}>{t('content.queue.file')}</Button>
      <div className="basis-full empty:hidden"><MaterialsError error={bind.error} /></div>
    </form>
  );
}

function Retry({ item }: { item: QueueItem }) {
  const { t } = useTranslation();
  const retry = useMaterialsMutation(() => m.materialAnalysisRetry(item.material.id, item.material.revision));
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" loading={retry.isPending} onClick={() => retry.mutate(undefined)}>{t('materials.intelligence.retry')}</Button>
      <MaterialsError error={retry.error} />
    </div>
  );
}

/**
 * "Analiz sırası": what was uploaded and is not yet in a folder, or whose analysis waits or runs,
 * oldest first, each with where it is. With no agent connected a file simply waits; the page says
 * so from the agent check-in. An analysed upload nobody filed is filed here by a person.
 */
export function QueueView({ tree }: { tree: TreeOut }) {
  const { t, i18n } = useTranslation();
  const key = useContentKey();
  const decider = useDecider();
  const [place] = useContentPlace();
  const workspace = useSession().data?.current_workspace;
  const queue = useQuery({ queryKey: [...key, 'queue'], queryFn: analysisQueue, refetchInterval: 15_000 });
  const work = useQuery({ queryKey: ['work', 'pending', workspace], queryFn: getPending, refetchInterval: 60_000, retry: false });
  const items = queue.data?.items ?? [];
  const agent = work.data?.agent;
  // Files the agent has yet to analyse; the notice speaks only when they wait and no agent is on time.
  const waiting = items.filter((i) => i.stage === 'waiting').length;
  const notice = agent ? agentNotice(t, i18n.language, waiting, [agent]) : null;
  const noAgent = !!notice;
  const line = (item: QueueItem) => {
    if (item.stage === 'waiting' && noAgent) return t('content.queue.line.noAgent');
    if (item.stage === 'needs_filing') return item.intelligence.description || t('content.queue.line.needs_filing');
    if (item.stage === 'failed') return t('content.queue.line.failed');
    return t(`content.queue.line.${item.stage}${item.unfiled ? '' : 'Filed'}`);
  };
  return (
    <section aria-label={t('content.queue.title')} className="min-w-0 space-y-5">
      <header className="flex items-start gap-3">
        <Inbox aria-hidden="true" className="h-9 w-9 shrink-0 text-muted-foreground" strokeWidth={1.3} />
        <div className="min-w-0">
          <h2 className="text-xl font-medium">{t('content.queue.title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('content.queue.help')}</p>
        </div>
      </header>
      {notice && (
        <p role="status" className="flex items-center gap-2 border-s-2 border-warning bg-warning-subtle px-4 py-2 text-sm">
          <Bot aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
          <Link className="min-w-0 underline underline-offset-4" to="/agents">{notice}</Link>
        </p>
      )}
      <QueryState query={queue} keepOnError>
        {queue.data && !items.length && <EmptyState title={t('content.queue.empty')} description={t('content.queue.emptyHelp')} />}
        {items.length > 0 && (
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {items.map((item) => (
              <li key={item.material.id} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto]">
                <Link to={placeHref({ ...place, file: item.material.id })} aria-label={materialLabel(t, item.material)} className="h-11 w-11 overflow-hidden rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_img]:h-11 [&_img]:object-cover [&_span]:h-11 [&_video]:h-11 [&_.text-xs]:hidden">
                  <MaterialPreview material={item.material} />
                </Link>
                <div className="min-w-0 space-y-1">
                  <Link to={placeHref({ ...place, file: item.material.id })} className="block truncate text-sm font-medium hover:underline">{materialLabel(t, item.material)}</Link>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{line(item)}</p>
                  {item.stage === 'needs_filing' && item.unfiled && (decider ? <FileInto item={item} tree={tree} /> : <p className="text-xs text-muted-foreground">{t('content.queue.managerFiles')}</p>)}
                  {item.stage === 'failed' && <Retry item={item} />}
                </div>
                <span className="col-start-2 sm:col-start-auto"><Badge tone={TONE[item.stage]}>{t(`content.queue.stage.${item.stage}`)}</Badge></span>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
