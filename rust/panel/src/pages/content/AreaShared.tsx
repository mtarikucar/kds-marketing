import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Image as ImageIcon, Play } from 'lucide-react';
import type { AreaState, OpenedBy } from '@/api/content';
import type { ProductionProject } from '@/api/projects';
import { materialPreview } from '@/api/materials';
import { Badge } from '@/components/ui';
import { useMaterialsKey } from '../materials/MaterialsShared';
import { placeHref, useContentPlace } from './location';

export const AREA_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export const stepName = (t: TFunction, step: number) => t(`contentAreas.steps.${AREA_STEPS.find(s => s === step) ?? 1}`);
export const currentPackage = (area: ProductionProject) => area.packages?.[area.packages.length - 1];

/** The server's state of an area, as a badge. */
export function StateBadge({ state }: { state: AreaState }) {
  const { t } = useTranslation();
  return <Badge tone={state === 'held' ? 'danger' : state === 'waiting_material' ? 'warning' : state === 'done' ? 'success' : state === 'working' ? 'info' : 'neutral'}>{t(`contentAreas.states.${state}`)}</Badge>;
}
export function openedBy(t: TFunction, opened: OpenedBy | undefined) {
  return opened?.kind === 'system' ? t(`contentAreas.opened.${opened.trigger}`) : t('contentAreas.opened.human');
}
export function areaTime(at: string | null | undefined, lang: string) {
  return at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

/**
 * A material as a small square, opening its file in the drawer. The preview is the server's
 * signed one; without it (no `materials.work`, a video, an erased file) the medium's icon shows.
 * With `link` false the preview is shown without opening anything (inside another button).
 */
export function MiniThumb({ id, size = 'h-8 w-8', files = true, link = true }: { id: string; size?: string; files?: boolean; link?: boolean }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [place] = useContentPlace();
  // An image first; a file that is no image is tried as a video (its first frame, with its
  // length), and only what is neither shows the icon. The server keeps no poster frame.
  const [mode, setMode] = useState<'image' | 'video' | 'none'>('image');
  const [seconds, setSeconds] = useState<number | null>(null);
  const preview = useQuery({ queryKey: [...key, 'preview-url', id], queryFn: () => materialPreview(id), enabled: files, staleTime: 60_000, retry: false });
  const url = preview.data?.url;
  const inner = url && mode === 'image'
    ? <img src={url} alt="" className="h-full w-full object-cover" onError={() => setMode('video')} />
    : url && mode === 'video'
      ? (
        <span className="relative block h-full w-full">
          <video src={`${url}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" className="h-full w-full object-cover"
            onLoadedMetadata={(e) => setSeconds(Number.isFinite(e.currentTarget.duration) ? Math.round(e.currentTarget.duration) : null)}
            onError={() => setMode('none')} />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/55 text-[0.625rem] leading-tight text-white">
            <Play aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
            {seconds != null && <span>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>}
            <span className="sr-only">{t('content.file.video')}</span>
          </span>
        </span>
      )
      : <ImageIcon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />;
  const box = `${size} flex shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-muted`;
  if (!files || !link) return <span className={box}>{inner}</span>;
  return <Link to={placeHref({ ...place, file: id })} aria-label={t('content.file.open')} className={`${box} hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>{inner}</Link>;
}
