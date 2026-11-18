import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, Folder, Inbox, Layers, Plus } from 'lucide-react';
import type { Folder as FolderCounts, TreeOut, UpcomingDay, WaitReason } from '@/api/content';
import { GENEL } from '@/api/content';
import { istanbulDay, type Olay } from '@/api/materials';
import { Button, cn } from '@/components/ui';
import { formatDay } from '../materials/MaterialsShared';
import { placeHref, type ContentPlace } from './location';

/** The groups of the tree (design 2026-11-18): Şimdi, Sürekli, Yaklaşan, Geçmiş. */
export interface TreeGroups {
  now: TreeOut['olays'];
  soon: ({ kind: 'olay'; item: TreeOut['olays'][number] } | { kind: 'day'; day: UpcomingDay })[];
  past: TreeOut['olays'];
}

/**
 * An olay is "now" while its days run, "soon" before they start and "past" after they end; one
 * that ended but still waits for a person stays "now" so its dot is not folded away. The special
 * days with no olay yet join "soon" by their window's start.
 */
export function groupTree(tree: TreeOut, today = istanbulDay(new Date())): TreeGroups {
  const now: TreeOut['olays'] = [];
  const past: TreeOut['olays'] = [];
  const soon: TreeGroups['soon'] = [];
  for (const item of tree.olays) {
    const { starts_on, ends_on } = item.olay;
    if (starts_on > today) soon.push({ kind: 'olay', item });
    else if (ends_on >= today || item.waits.length) now.push(item);
    else past.push(item);
  }
  for (const day of tree.upcoming) soon.push({ kind: 'day', day });
  const start = (s: TreeGroups['soon'][number]) => (s.kind === 'olay' ? s.item.olay.starts_on : s.day.window_start);
  soon.sort((a, b) => start(a).localeCompare(start(b)));
  return { now, soon, past };
}

export const dayId = (day: UpcomingDay) => `${day.key}:${day.year}`;

/** The strongest reason a folder waits for a person: a stuck content first. */
function waitTone(waits: WaitReason[]): 'danger' | 'warning' | null {
  if (waits.includes('content_problem')) return 'danger';
  return waits.length ? 'warning' : null;
}

function Row({
  to,
  current,
  icon,
  name,
  trailing,
  muted,
}: {
  to: string;
  current: boolean;
  icon: ReactNode;
  name: string;
  trailing?: ReactNode;
  muted?: boolean;
}) {
  return (
    <li>
      <Link
        to={to}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8',
          current ? 'bg-primary/10 font-medium text-primary' : muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {trailing}
      </Link>
    </li>
  );
}

function FolderRow({ id, name, folder, place, muted }: { id: string; name: string; folder: FolderCounts; place: ContentPlace; muted?: boolean }) {
  const { t } = useTranslation();
  const tone = waitTone(folder.waits);
  return (
    <Row
      to={placeHref({ olay: id })}
      current={place.olay === id}
      muted={muted}
      icon={<Folder aria-hidden="true" className="h-4 w-4 shrink-0 fill-surface-muted text-muted-foreground" />}
      name={name}
      trailing={
        <>
          {tone && (
            <span className={cn('h-2 w-2 shrink-0 rounded-full', tone === 'danger' ? 'bg-danger' : 'bg-warning')}>
              <span className="sr-only">{t('content.tree.waiting')}</span>
            </span>
          )}
          <span className="font-mono text-xs text-muted-foreground" aria-label={t('content.tree.files', { count: folder.files })}>
            {folder.files}
          </span>
        </>
      }
    />
  );
}

function OlayRow({ item, place, muted }: { item: TreeOut['olays'][number]; place: ContentPlace; muted?: boolean }) {
  return <FolderRow id={item.olay.id} name={item.olay.title} folder={item} place={place} muted={muted} />;
}

function Heading({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/**
 * The left tree: "Tüm üretim", the olays by when they are, the permanent Genel folder, the
 * special days coming up, and "Analiz sırası" at the foot with its size.
 */
export function ContentTree({
  tree,
  place,
  queue,
  contents,
  onNewOlay,
  top,
}: {
  tree: TreeOut;
  place: ContentPlace;
  /** The session may read the analysis queue (`materials.work`). */
  queue: boolean;
  /** The session sees contents. */
  contents: boolean;
  onNewOlay?: () => void;
  /** Shown above the folders (the phone's "Sizi bekleyenler"). */
  top?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const groups = groupTree(tree);
  const [pastOpen, setPastOpen] = useState(() => groups.past.some((o) => o.olay.id === place.olay));
  const home = !place.olay && !place.day && place.view !== 'queue';
  return (
    <nav aria-label={t('content.tree.label')} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-2">
      {top}
      <ul className="space-y-px">
        {contents && (
          <Row
            to={placeHref({ view: 'all' })}
            current={home}
            icon={<Layers aria-hidden="true" className="h-4 w-4 shrink-0" />}
            name={t('content.tree.all')}
            trailing={<span className="font-mono text-xs text-muted-foreground">{tree.areas}</span>}
          />
        )}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <Heading>{t('content.tree.now')}</Heading>
        {onNewOlay && (
          <Button variant="ghost" size="sm" className="mt-2 h-8 gap-1 px-2 text-xs" onClick={onNewOlay}>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            {t('content.tree.newOlay')}
          </Button>
        )}
      </div>
      <ul className="space-y-px">
        {groups.now.map((item) => <OlayRow key={item.olay.id} item={item} place={place} />)}
        {!groups.now.length && <li className="px-2 py-1 text-xs text-muted-foreground">{t('content.tree.noneNow')}</li>}
      </ul>
      <Heading>{t('content.tree.always')}</Heading>
      <ul className="space-y-px">
        <FolderRow id={GENEL} name={t('content.genel')} folder={tree.genel} place={place} />
      </ul>
      {groups.soon.length > 0 && (
        <>
          <Heading>{t('content.tree.soon')}</Heading>
          <ul className="space-y-px">
            {groups.soon.map((s) =>
              s.kind === 'olay' ? (
                <OlayRow key={s.item.olay.id} item={s.item} place={place} />
              ) : (
                <Row
                  key={dayId(s.day)}
                  to={placeHref({ day: dayId(s.day) })}
                  current={place.day === dayId(s.day)}
                  muted
                  icon={<Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground [stroke-dasharray:2_2]" />}
                  name={s.day.name}
                  trailing={<span className="text-xs text-muted-foreground">{formatDay(s.day.window_start, i18n.language, false)}</span>}
                />
              ),
            )}
          </ul>
        </>
      )}
      {groups.past.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={pastOpen}
            onClick={() => setPastOpen((open) => !open)}
            className="mt-3 flex min-h-11 w-full items-center gap-1 rounded-md px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
          >
            <ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5 transition-transform', !pastOpen && '-rotate-90')} />
            {t('content.tree.past')}
            <span className="font-mono">{groups.past.length}</span>
          </button>
          {pastOpen && (
            <ul className="space-y-px">
              {groups.past.map((item) => <OlayRow key={item.olay.id} item={item} place={place} muted />)}
            </ul>
          )}
        </>
      )}
      {queue && (
        <ul className="mt-3 border-t border-border pt-2">
          <Row
            to={placeHref({ view: 'queue' })}
            current={place.view === 'queue'}
            icon={<Inbox aria-hidden="true" className="h-4 w-4 shrink-0" />}
            name={t('content.queue.title')}
            trailing={<span className="rounded-full bg-surface-muted px-2 font-mono text-xs text-muted-foreground">{tree.analysis_queue}</span>}
          />
        </ul>
      )}
    </nav>
  );
}

/** An olay of the tree by id, for the views that name it. */
export function treeOlay(tree: TreeOut | undefined, id: string | null | undefined): Olay | undefined {
  return tree?.olays.find((o) => o.olay.id === id)?.olay;
}
