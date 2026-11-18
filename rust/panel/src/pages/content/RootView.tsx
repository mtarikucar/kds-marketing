import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Folder } from 'lucide-react';
import { contentAreas, GENEL, type AreaRow, type TreeOut } from '@/api/content';
import { Button, cn, EmptyState } from '@/components/ui';
import { QueryState } from '@/components/QueryState';
import { folderOf, placeHref, useContentKey, useContentPlace } from './location';
import { PipelineRow } from './PipelineRow';
import { MissingContent } from './MissingContent';

const FILTERS = ['all', 'working', 'waiting', 'done', 'archived'] as const;
type Filter = (typeof FILTERS)[number];

/** Which filter a row answers, from the server's state and stages only. */
function matches(row: AreaRow, filter: Filter): boolean {
  switch (filter) {
    case 'all':
    case 'archived':
      return true;
    case 'working':
      return row.area.status.state === 'queued' || row.area.status.state === 'working';
    case 'waiting':
      return row.pipeline.stages.some((s) => s.state === 'waiting_person' || s.state === 'problem');
    case 'done':
      return row.area.status.state === 'done';
  }
}

/**
 * "Tüm üretim": every content's production line, grouped by its olay (Genel last), open ones by
 * their start and then the finished ones; the archive on request.
 */
export function RootView({ tree, manage, files }: { tree: TreeOut; manage: boolean; files: boolean }) {
  const { t } = useTranslation();
  const key = useContentKey();
  const [place, go] = useContentPlace();
  const [filter, setFilter] = useState<Filter>('all');
  const archived = filter === 'archived';
  const open = useQuery({ queryKey: [...key, 'areas', 'open'], queryFn: () => contentAreas({ scope: 'open' }), enabled: !archived, refetchInterval: 30_000 });
  const done = useInfiniteQuery({
    queryKey: [...key, 'areas', 'done'],
    queryFn: ({ pageParam }) => contentAreas({ scope: 'done', done_before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_done_before ?? undefined,
    enabled: !archived,
    refetchInterval: 30_000,
  });
  const archive = useInfiniteQuery({
    queryKey: [...key, 'areas', 'archived'],
    queryFn: ({ pageParam }) => contentAreas({ archived: true, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: archived,
  });
  const opens = [...(open.data?.areas ?? [])].sort(
    (a, b) => Date.parse(a.area.status.starts_at) - Date.parse(b.area.status.starts_at) || a.area.id.localeCompare(b.area.id),
  );
  const rows = archived ? archive.data?.pages.flatMap((p) => p.areas) ?? [] : [...opens, ...(done.data?.pages.flatMap((p) => p.areas) ?? [])];
  const unique = rows.filter((row, index) => rows.findIndex((r) => r.area.id === row.area.id) === index);
  const shown = unique.filter((r) => matches(r, filter));
  const ready = archived ? archive.isSuccess : open.isSuccess && done.isSuccess;
  const more = archived ? archive : done;
  // Folders in the tree's order, Genel last.
  const order = [...tree.olays.map((o) => o.olay.id), GENEL];
  const groups = order
    .map((id) => ({ id, rows: shown.filter((r) => folderOf(r.area.olay_id) === id) }))
    .filter((g) => g.rows.length);
  const orphans = shown.filter((r) => !order.includes(folderOf(r.area.olay_id)));
  if (orphans.length) groups.push({ id: GENEL, rows: orphans });
  const folderName = (id: string) => (id === GENEL ? t('content.genel') : tree.olays.find((o) => o.olay.id === id)?.olay.title ?? t('content.unknownOlay'));
  const counts = (id: string) => (id === GENEL ? tree.genel : tree.olays.find((o) => o.olay.id === id));
  const toggle = (id: string) =>
    place.content === id ? go({ ...place, content: undefined }, { replace: true }) : go({ ...place, content: id });
  const status = archived
    ? archive
    : {
        isLoading: open.isLoading || done.isLoading,
        isError: open.isError || done.isError,
        error: open.error ?? done.error,
        data: open.data && done.data,
        refetch: () => Promise.all([open.isError ? open.refetch() : null, done.isError ? done.refetch() : null]),
      };
  return (
    <section aria-label={t('content.tree.all')} className="min-w-0 space-y-4">
      <div role="group" aria-label={t('content.root.filters')} className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              filter === f ? 'border-transparent bg-primary/10 font-medium text-primary' : 'border-border bg-surface hover:border-border-strong',
            )}
          >
            {t(`content.root.filter.${f}`)}
            {f !== 'archived' && ready && !archived && <span className="font-mono text-xs opacity-75">{unique.filter((r) => matches(r, f)).length}</span>}
          </button>
        ))}
        <span className="ms-auto hidden text-xs text-muted-foreground lg:inline">{t('content.root.hint')}</span>
      </div>
      <QueryState query={status} keepOnError>
        {place.content && ready && !unique.some((r) => r.area.id === place.content) && <MissingContent id={place.content} manage={manage} files={files} />}
        {ready && !shown.length && (
          <EmptyState
            title={t(archived ? 'contentAreas.archiveEmpty' : unique.length ? 'content.root.noMatch' : 'content.root.empty')}
            description={archived ? t('contentAreas.archiveHelp') : unique.length ? undefined : t('content.root.emptyHelp')}
          />
        )}
        {groups.map((g) => {
          const c = counts(g.id);
          return (
            <section key={g.id} aria-label={folderName(g.id)} className="space-y-3">
              <Link to={placeHref({ olay: g.id })} className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Folder aria-hidden="true" className="h-5 w-5 fill-surface-muted text-muted-foreground" />
                <span className="font-medium group-hover:underline">{folderName(g.id)}</span>
                {c && <span className="text-sm text-muted-foreground">{t('content.folderSummary', { files: c.files, areas: c.areas, published: c.published })}</span>}
              </Link>
              {g.rows.map((row) => (
                <PipelineRow key={row.area.id} row={row} expanded={place.content === row.area.id} onToggle={() => toggle(row.area.id)} manage={manage} files={files} />
              ))}
            </section>
          );
        })}
        {more.hasNextPage && (
          <Button variant="outline" loading={more.isFetchingNextPage} onClick={() => void more.fetchNextPage()}>
            {t('contentAreas.more')}
          </Button>
        )}
      </QueryState>
    </section>
  );
}
