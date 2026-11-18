import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Image as ImageIcon } from 'lucide-react';
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
 */
export function MiniThumb({ id, size = 'h-8 w-8', files = true }: { id: string; size?: string; files?: boolean }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [place] = useContentPlace();
  const [failed, setFailed] = useState(false);
  const preview = useQuery({ queryKey: [...key, 'preview-url', id], queryFn: () => materialPreview(id), enabled: files, staleTime: 60_000, retry: false });
  const inner = preview.data?.url && !failed
    ? <img src={preview.data.url} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
    : <ImageIcon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />;
  const box = `${size} flex shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-muted`;
  if (!files) return <span className={box}>{inner}</span>;
  return <Link to={placeHref({ ...place, file: id })} aria-label={t('content.file.open')} className={`${box} hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>{inner}</Link>;
}
