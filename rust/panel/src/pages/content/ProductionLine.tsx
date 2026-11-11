import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { areasList } from '@/api/content';
import { projectsList } from '@/api/projects';
import { Button, EmptyState } from '@/components/ui';
import { MaterialsReadStatus, useMaterialsKey } from '../materials/MaterialsShared';
import { AreaBadge, areaSentence, areaState, areaTime, currentPackage, openedBy, startsAt } from './AreaShared';
import { OpenArea } from './OpenArea';

export function ProductionLine({ manage, onOpen }: { manage: boolean; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const key = [...useMaterialsKey(), 'areas'];
  const [archived, setArchived] = useState(false);
  const [opening, setOpening] = useState(false);
  const open = useQuery({ queryKey: [...key, 'open'], queryFn: () => areasList('open'), enabled: !archived, refetchInterval: 30_000 });
  const done = useInfiniteQuery({ queryKey: [...key, 'done'], queryFn: ({ pageParam }) => areasList('done', pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next_done_before ?? undefined, enabled: !archived, refetchInterval: 30_000 });
  const archive = useInfiniteQuery({ queryKey: [...key, 'archive'], queryFn: ({ pageParam }) => projectsList(true, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next_cursor ?? undefined, enabled: archived });
  const opens = [...(open.data?.projects ?? [])].sort((a, b) => Date.parse(startsAt(a)) - Date.parse(startsAt(b)) || a.id.localeCompare(b.id));
  const finished = (done.data?.pages.flatMap(p => p.projects) ?? []).sort((a, b) => Date.parse(currentPackage(b)?.delivered_at ?? b.updated_at) - Date.parse(currentPackage(a)?.delivered_at ?? a.updated_at));
  const rows = archived ? archive.data?.pages.flatMap(p => p.projects) ?? [] : [...opens, ...finished];
  const unique = rows.filter((row, index) => rows.findIndex(r => r.id === row.id) === index);
  const ready = archived ? archive.isSuccess : open.isSuccess && done.isSuccess;
  const more = archived ? archive : done;
  return <section className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-medium">{t('contentAreas.line')}</h2>{manage && <Button onClick={() => setOpening(true)}>{t('contentAreas.open')}</Button>}</div>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />{t('contentAreas.archive')}</label>
    {/* The line is two reads of one list (open and finished): one state and one retry for both. */}
    <MaterialsReadStatus query={archived ? archive : {
      isLoading: open.isLoading || done.isLoading,
      error: open.error ?? done.error,
      refetch: () => Promise.all([open.isError ? open.refetch() : null, done.isError ? done.refetch() : null]),
    }} />
    {ready && !unique.length && <EmptyState title={t(archived ? 'contentAreas.archiveEmpty' : 'contentAreas.empty')} description={t(archived ? 'contentAreas.archiveHelp' : 'contentAreas.openHelp')} />}
    {unique.length > 0 && <ul aria-label={t('contentAreas.line')} className="divide-y divide-border border-y border-border">
      {unique.map(area => <li key={area.id} className={`grid min-w-0 items-center gap-3 px-3 py-5 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto] ${areaState(area) === 'waiting_material' ? 'bg-warning-subtle' : ''}`}>
        <time dateTime={startsAt(area)} className="text-sm tabular-nums text-muted-foreground">{areaTime(startsAt(area), i18n.language)}</time>
        <div className="min-w-0"><Link className="break-words font-medium underline decoration-border underline-offset-4" to={`/content?area=${encodeURIComponent(area.id)}`}>{area.title}</Link><p className="mt-1 text-xs text-muted-foreground">{openedBy(t, area)}</p></div>
        <p className="break-words text-sm">{areaSentence(t, area)}</p><div><AreaBadge area={area} /></div>
      </li>)}
    </ul>}
    {more.hasNextPage && <Button variant="outline" loading={more.isFetchingNextPage} onClick={() => void more.fetchNextPage()}>{t('contentAreas.more')}</Button>}
    {opening && <OpenArea onClose={() => setOpening(false)} onCreated={onOpen} />}
  </section>;
}
