import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { materialPreview, type Material } from '@/api/materials';
import type { PackageVersion } from '@/api/content';
import { Button } from '@/components/ui';
import { materialLabel, useMaterialsKey } from '../materials/MaterialsShared';

function FrameMedia({ material }: { material?: Material }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [failedUrl, setFailedUrl] = useState<string>();
  const preview = useQuery({ queryKey: [...key, 'preview', material?.id, material?.revision], queryFn: () => materialPreview(material!.id), enabled: !!material && !material.erased_at, staleTime: 60_000, refetchInterval: 240_000, retry: false });
  const url = preview.data?.url;
  if (!material || material.erased_at || !url || url === failedUrl) return <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">{t(preview.isLoading ? 'common.loading' : 'materials.intelligence.previewUnavailable')}</p>;
  const alt = materialLabel(t, material);
  return material.mime.startsWith('video/')
    ? <video className="absolute inset-0 h-full w-full object-contain" controls playsInline preload="metadata" src={url} aria-label={alt} onError={() => setFailedUrl(url)} />
    : <img className="absolute inset-0 h-full w-full object-contain" src={url} alt={alt} onError={() => setFailedUrl(url)} />;
}
export function PlatformFrame({ version, materials, account }: { version: PackageVersion; materials: Material[]; account: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const vertical = ['story', 'reel', 'tiktok_video'].includes(version.format);
  const carousel = version.format === 'carousel';
  const ids = version.material_ids;
  const caption = <div className="space-y-2 break-words"><p className="whitespace-pre-wrap text-sm">{version.text}</p><p className="text-xs">{version.tags.map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ')}</p></div>;
  return <div data-testid="platform-frame" className="mx-auto w-full min-w-0 max-w-[22rem] overflow-hidden rounded-[2rem] border-[6px] border-foreground/80 bg-surface shadow-sm">
    <div className="mx-auto mt-2 h-1 w-12 rounded-full bg-border" aria-hidden="true" />
    <p className="break-words px-4 py-3 text-sm font-medium">{account}</p>
    <div className="relative overflow-hidden bg-surface-muted" style={{ aspectRatio: vertical ? '9 / 16' : '1 / 1' }}>
      <FrameMedia key={ids[page]} material={materials.find(m => m.id === ids[page])} />
      {vertical && <div className="pointer-events-none absolute inset-x-0 bottom-12 max-h-[40%] overflow-hidden bg-gradient-to-t from-black/85 to-transparent px-4 pb-4 pt-10 text-white">{caption}</div>}
    </div>
    {carousel && <div className="flex flex-wrap items-center justify-between gap-1 px-2 py-2">
      <Button variant="ghost" size="sm" aria-label={t('contentAreas.previousMedia')} disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</Button>
      <div className="flex max-w-[60%] flex-wrap justify-center gap-1" aria-label={t('contentAreas.mediaPage', { n: page + 1, total: ids.length })}>{ids.map((id, index) => <span key={`${id}-${index}`} aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${page === index ? 'bg-foreground' : 'bg-border'}`} />)}</div>
      <Button variant="ghost" size="sm" aria-label={t('contentAreas.nextMedia')} disabled={page >= ids.length - 1} onClick={() => setPage(p => p + 1)}>›</Button>
    </div>}
    {!vertical && <div className="px-4 pb-5 pt-3">{caption}</div>}
  </div>;
}
