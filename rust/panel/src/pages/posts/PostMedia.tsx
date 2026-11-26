import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2 } from 'lucide-react';
import type { Cover, PostRow } from '@/api/postsPage';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Skeleton } from '@/components/ui';
import { Thumb } from './PostsTable';

const isVideo = (c: Cover) => c.mime.startsWith('video/');

/**
 * One picture or video of the post, as wide as the panel. A picture opens full size over the
 * page; a video plays in place, its first frame standing for its poster (materials carry none).
 * The addresses are the read's own short-lived signed ones; nothing is kept past them.
 */
function Item({ cover, title, index, count, onOpen }: { cover: Cover; title: string; index: number; count: number; onOpen: (c: Cover) => void }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const url = cover.preview_url;
  const label = count > 1 ? t('postsPage.media.slide', { n: index + 1, count }) : undefined;
  if (!url || failed) {
    return (
      <span aria-label={label} className="flex aspect-square w-full items-center justify-center rounded-xl border border-border bg-surface-muted">
        <Thumb cover={null} format={isVideo(cover) ? 'reel' : 'feed_post'} size="h-12 w-12" />
      </span>
    );
  }
  return (
    <figure className="relative m-0" aria-label={label}>
      {isVideo(cover) ? (
        <video
          data-testid="post-video"
          src={`${url}#t=0.1`}
          controls
          playsInline
          preload="metadata"
          className="block max-h-[70vh] w-full rounded-xl bg-black object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <button
          type="button"
          className="group block w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label ? `${label} · ${t('postsPage.media.full')}` : t('postsPage.media.full')}
          onClick={() => onOpen(cover)}
        >
          <img src={url} alt={title} className="block max-h-[70vh] w-full rounded-xl bg-surface-muted object-contain" onError={() => setFailed(true)} />
          <span aria-hidden="true" className="absolute end-2 top-2 rounded-md bg-black/55 p-1 text-white opacity-80 group-hover:opacity-100">
            <Maximize2 className="h-3.5 w-3.5" />
          </span>
        </button>
      )}
      {label && <span aria-hidden="true" className="absolute start-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">{index + 1}/{count}</span>}
    </figure>
  );
}

/**
 * The post itself, first and large (the panel's head): one picture fitted to the panel's width,
 * every slide of a carousel in order (side by side, swiped on a phone), or the video. Before the
 * row's own read answers, the list's cover stands in; with nothing signed to show (a viewer
 * without `materials.work`), the format's icon.
 */
export function PostMedia({ row, materials, loading }: { row: PostRow; materials: Cover[] | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const [full, setFull] = useState<Cover | null>(null);
  const shown = materials ?? (row.cover ? [row.cover] : []);
  if (!shown.some((c) => c.preview_url)) {
    if (loading && !materials) return <Skeleton className="aspect-square w-full rounded-xl" />;
    return <Thumb cover={null} format={row.format} size="h-[92px] w-[92px]" />;
  }
  const many = shown.length > 1;
  return (
    <section aria-label={t('postsPage.media.label')} data-testid="post-media">
      {many ? (
        <ol className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1">
          {shown.map((c, i) => (
            <li key={`${c.material_id}-${i}`} data-slide={i + 1} className="w-[85%] shrink-0 snap-center">
              <Item cover={c} title={row.title} index={i} count={shown.length} onOpen={setFull} />
            </li>
          ))}
        </ol>
      ) : (
        <Item cover={shown[0]} title={row.title} index={0} count={1} onOpen={setFull} />
      )}
      <Dialog open={!!full} onOpenChange={(open) => { if (!open) setFull(null); }}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-5xl place-items-center bg-surface p-2 sm:p-3">
          <DialogTitle className="sr-only">{row.title}</DialogTitle>
          <DialogDescription className="sr-only">{t('postsPage.media.full')}</DialogDescription>
          {full?.preview_url && <img src={full.preview_url} alt={row.title} className="block h-auto max-h-[calc(100dvh-5rem)] w-full object-contain" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
