import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clapperboard, GalleryHorizontal, Image as ImageIcon, Layers, Play, SquareStack } from 'lucide-react';
import type { StageKey } from '@/api/content';
import { STAGE_KEYS, type ChannelRef, type Cover, type PostCounts, type PostRow, type PostsFilter, type Progress } from '@/api/postsPage';
import { cn, Skeleton } from '@/components/ui';
import { groupCover, groupRows, type PostGroup } from './groups';
import { channelLabel, STATUS_TONE, stageLabel, statusWord, subLine, whenWords, type Tone } from './words';

const PILL: Record<Tone, string> = {
  red: 'bg-danger-subtle text-danger',
  amber: 'bg-warning-subtle text-warning',
  violet: 'bg-primary/10 text-primary',
  grey: 'bg-surface-muted text-muted-foreground',
  green: 'bg-success-subtle text-success',
};

/** The row's status as a pill (§2.4). */
export function StatusPill({ row }: { row: Pick<PostRow, 'status' | 'tiktok_draft'> }) {
  const { t } = useTranslation();
  const tone = row.status === 'published' && row.tiktok_draft ? 'green' : STATUS_TONE[row.status];
  return <span className={cn('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', PILL[tone])}>{statusWord(t, row)}</span>;
}

/** The Kanal badge: the platform's name, `{Platform} · {hesap}` when two accounts share it; `—` while none is chosen. */
export function ChannelBadge({ channel }: { channel: ChannelRef | null }) {
  const { t } = useTranslation();
  if (!channel) return <span title={t('postsPage.table.agentPicks')} className="text-muted-foreground">—</span>;
  return (
    <span className={cn('inline-flex max-w-full truncate rounded px-1.5 py-0.5 text-[0.6875rem] font-bold', channel.kind === 'tiktok' ? 'bg-foreground text-background' : 'bg-primary/10 text-primary')}>
      {channelLabel(t, channel)}
    </span>
  );
}

/** The eight dots of the pipeline (§2.5): done green, the current one ringed, the rest grey. */
export function Dots({ progress }: { progress: Progress }) {
  const { t } = useTranslation();
  const finished = progress.index >= 7 && progress.state === 'done';
  const done = finished ? 8 : Math.max(0, Math.min(7, progress.index));
  const ring = progress.state === 'waiting_person' ? 'border-warning' : progress.state === 'problem' ? 'border-danger' : 'border-primary';
  return (
    <span role="img" aria-label={t('postsPage.table.dots', { n: done })} className="flex items-center" data-testid="dots">
      {STAGE_KEYS.map((key, i) => {
        const isDone = i < done;
        const current = !finished && i === done;
        return (
          <span key={key} className="flex items-center">
            <span
              data-state={isDone ? 'done' : current ? progress.state : 'todo'}
              className={cn(
                'inline-block shrink-0 rounded-full',
                current ? cn('h-[11px] w-[11px] border-[3px] bg-surface', ring) : cn('h-[7px] w-[7px]', isDone ? 'bg-success' : 'bg-border-strong'),
              )}
            />
            {i < 7 && <span className={cn('inline-block h-0.5 w-1.5 shrink-0', i < done ? 'bg-success' : 'bg-border')} />}
          </span>
        );
      })}
    </span>
  );
}

/** The format's icon when a row has no image to show (§2.2: "a neutral icon of the format"). */
function FormatIcon({ format, className }: { format: PostRow['format']; className?: string }) {
  const Icon = format === 'tiktok_video' || format === 'reel' ? Clapperboard : format === 'carousel' ? GalleryHorizontal : format === 'story' ? SquareStack : format ? ImageIcon : Layers;
  return <Icon aria-hidden="true" className={cn('h-5 w-5 text-muted-foreground', className)} />;
}

/**
 * A row's picture: the cover's preview (a video's first frame with its length and a play mark),
 * else the format's icon; a preview that fails to load shows the icon too (§2.10).
 */
export function Thumb({ cover, format, seconds, size = 'h-12 w-12' }: { cover: Cover | null; format: PostRow['format']; seconds?: number | null; size?: string }) {
  const [failed, setFailed] = useState(false);
  const url = !failed ? cover?.preview_url : null;
  const video = !!cover?.mime.startsWith('video/');
  return (
    <span className={cn(size, 'relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-muted')}>
      {url && !video && <img src={url} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />}
      {url && video && (
        <>
          <video src={`${url}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" className="h-full w-full object-cover" onError={() => setFailed(true)} />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/55 text-[0.625rem] leading-tight text-white">
            <Play aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
            {seconds != null && <span>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>}
          </span>
        </>
      )}
      {!url && <FormatIcon format={format} />}
    </span>
  );
}

/** The chips (§2.2 item 5): Tümü, Seni bekleyen, then each stage that holds a row, counts from the server. */
export function Chips({ counts, filter, onFilter, loading }: { counts?: PostCounts; filter: PostsFilter | undefined; onFilter: (f: PostsFilter | undefined) => void; loading: boolean }) {
  const { t } = useTranslation();
  const busy = loading || !counts;
  const stages = counts ? STAGE_KEYS.filter((k) => (counts.stages[k] ?? 0) > 0) : [];
  const chip = (key: PostsFilter | undefined, label: string, count: number, warn = false) => {
    const on = filter === key;
    return (
      <button
        key={key ?? 'all'}
        type="button"
        aria-pressed={on}
        onClick={() => onFilter(key)}
        className={cn(
          'inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg border px-3.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          on ? 'border-primary bg-primary/10 font-semibold text-primary' : warn ? 'border-warning/40 bg-warning-subtle text-warning' : 'border-border bg-surface text-foreground hover:border-border-strong',
        )}
      >
        <span>{label}</span>
        <span className={cn('text-xs tabular-nums', on ? 'text-primary' : 'text-muted-foreground')}>{count}</span>
      </button>
    );
  };
  // One element whether loading or not, so what holds it keeps holding it.
  return (
    <div role="group" aria-label={t('postsPage.chips.label')} aria-busy={busy || undefined} className="flex gap-2 overflow-x-auto pb-1 max-sm:-mx-4 max-sm:px-4 sm:flex-wrap sm:overflow-visible">
      {busy || !counts ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-24 shrink-0 rounded-lg" />) : (
        <>
          {chip(undefined, t('postsPage.chips.all'), counts.all)}
          {chip('you', t('postsPage.chips.you'), counts.you, counts.you > 0)}
          {stages.map((k: StageKey) => chip(k, stageLabel(t, k), counts.stages[k] ?? 0))}
        </>
      )}
    </div>
  );
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,16rem)] items-center gap-3';

/**
 * One version of a content on its table line: its platform, its own state and its own time.
 * Every version the read returned gets one, so a state that needs the owner is never hidden
 * behind a sibling that is fine.
 */
export function VersionChip({ row }: { row: PostRow }) {
  const { t, i18n } = useTranslation();
  return (
    <span data-version={row.id} className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <ChannelBadge channel={row.channel} />
      <StatusPill row={row} />
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{whenWords(t, row.published_at ?? row.publish_at, i18n.language)}</span>
    </span>
  );
}

function Versions({ group }: { group: PostGroup }) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {group.members.map((m) => <VersionChip key={m.id} row={m} />)}
    </span>
  );
}

/** One line of the desk table, a button that opens its content. */
function TableRow({ group, selected, onSelect }: { group: PostGroup; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const { lead } = group;
  const pic = groupCover(group);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        data-row={lead.id}
        data-group={group.key}
        onClick={onSelect}
        className={cn(
          GRID,
          'w-full border-b border-s-[3px] border-b-border px-4 py-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          selected ? 'border-s-primary bg-primary/5' : 'border-s-transparent bg-surface hover:bg-surface-muted/60',
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <Thumb cover={pic.cover} format={pic.format} seconds={pic.media?.video_seconds} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold">{lead.title}</span>
            <span className="truncate text-xs text-muted-foreground">{subLine(t, lead)}</span>
          </span>
        </span>
        <Dots progress={lead.progress} />
        <Versions group={group} />
      </button>
    </li>
  );
}

/** One line as a phone card (§2.10 "< 640 px"). */
function CardRow({ group, selected, onSelect }: { group: PostGroup; selected: boolean; onSelect: () => void }) {
  const { lead } = group;
  const pic = groupCover(group);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        data-row={lead.id}
        data-group={group.key}
        onClick={onSelect}
        className={cn('flex w-full gap-3 rounded-xl border bg-surface p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', selected ? 'border-primary' : 'border-border')}
      >
        <Thumb cover={pic.cover} format={pic.format} seconds={pic.media?.video_seconds} size="h-14 w-14" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="line-clamp-2 text-sm font-semibold">{lead.title}</span>
          <Versions group={group} />
          <Dots progress={lead.progress} />
        </span>
      </button>
    </li>
  );
}

/** Five grey rows while the first page is read (§2.10 Loading). */
export function TableSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t('common.loading')} className="space-y-px overflow-hidden rounded-xl border border-border bg-surface">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="h-12 w-12 rounded-lg" />
          <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-2/5" /></div>
          <Skeleton className="h-5 w-20 rounded-full max-sm:hidden" />
        </div>
      ))}
    </div>
  );
}

/**
 * The one table (§2.2 item 6): a line is one content, its versions (one per platform or account)
 * as chips inside it. On a phone the lines are cards; the columns are Paylaşım, Süreç and Kanallar.
 */
export function PostsTable({ rows, selectedKey, onSelect, phone, empty, more }: {
  rows: PostRow[];
  /** The group of the row the panel shows. */
  selectedKey: string | undefined;
  /** The row a line opens: the one of it already shown, else its lead. */
  onSelect: (row: PostRow) => void;
  phone: boolean;
  /** Said in place of the rows when there are none. */
  empty?: React.ReactNode;
  /** `Daha fazla göster`, while the server has a next page. */
  more?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupRows(rows), [rows]);
  const line = (g: PostGroup, Row: typeof TableRow) => (
    <Row key={g.key} group={g} selected={g.key === selectedKey} onSelect={() => onSelect(g.lead)} />
  );
  return (
    <section aria-label={t('postsPage.table.label')} className="min-w-0 space-y-2.5">
      {phone ? (
        groups.length ? <ul className="space-y-2">{groups.map((g) => line(g, CardRow))}</ul> : empty
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="overflow-x-auto">
            <div className="min-w-[40rem]">
              <div aria-hidden="true" className={cn(GRID, 'border-b border-border bg-surface-muted/50 px-4 py-2.5 text-xs font-semibold text-muted-foreground')}>
                <span>{t('postsPage.table.post')}</span>
                <span>{t('postsPage.table.progress')}</span>
                <span>{t('postsPage.table.versions')}</span>
              </div>
              {groups.length ? <ul>{groups.map((g) => line(g, TableRow))}</ul> : empty}
            </div>
          </div>
        </div>
      )}
      {more}
    </section>
  );
}
