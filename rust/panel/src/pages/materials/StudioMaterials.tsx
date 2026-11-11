import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import * as m from '@/api/materials';
import { MaterialsLibrary } from './MaterialsLibrary';
import { MaterialEditor } from './MaterialEditor';
import { MaterialsOlays } from './MaterialsOlays';
import { MaterialsShoots } from './MaterialsShoots';
import { MaterialsUpload } from './MaterialsUpload';
import { useMaterialsKey } from './MaterialsShared';

export const MATERIAL_VIEWS = ['upload', 'library', 'olays', 'shoots'] as const;
export type MaterialView = (typeof MATERIAL_VIEWS)[number];

/** A library view and an optional olay or material detail. */
export function materialsHref(view: MaterialView, extra: Record<string, string> = {}): string {
  return `/materials?${new URLSearchParams({ view, ...extra }).toString()}`;
}

/**
 * The material library: uploads, library, events and shoots. Its location lives in the address, so the phone's
 * back button walks back through it and Today links straight into it.
 */
export function StudioMaterials({ onOpenSlot }: { onOpenSlot: (id: string) => void }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: MaterialView = (MATERIAL_VIEWS as readonly string[]).includes(raw ?? '')
    ? (raw as MaterialView)
    : 'upload';
  const go = (next: MaterialView, extra: Record<string, string> = {}) =>
    setParams({ view: next, ...extra });
  const olay = params.get('olay') ?? undefined;
  const material = params.get('material') ?? undefined;
  // The count on the Çekim listesi button: what waits to be shot or uploaded.
  const shoots = useQuery({ queryKey: [...key, 'shoots', 'open'], queryFn: () => m.shootList('open') });
  const openOlay = (id: string | null) => go('olays', id ? { olay: id } : {});
  const openMaterial = (id: string) => go(view === 'library' ? 'library' : 'olays', { ...(olay ? { olay } : {}), material: id });
  return (
    <div className="space-y-6" data-testid="studio-materials">
      <nav aria-label={t('materials.tab')}>
        <ul className="flex flex-wrap gap-1 border-b border-border pb-3">
          {MATERIAL_VIEWS.map((v) => (
            <li key={v}>
              <button
                type="button"
                aria-current={view === v ? 'page' : undefined}
                onClick={() => go(v)}
                className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  view === v
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
                }`}
              >
                {v === 'library' ? t('materials.intelligence.library') : t(`materials.views.${v}`)}
                {v === 'shoots' && (shoots.data?.length ?? 0) > 0 && (
                  <span className="rounded-full bg-warning-subtle px-2 text-xs">{shoots.data!.length}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {view === 'upload' && (
        <MaterialsUpload key={olay ?? ''} presetOlay={olay} onOpenOlay={(id) => openOlay(id)} />
      )}
      {view === 'library' && !material && <MaterialsLibrary onOpen={(id) => go('library', { material: id })} />}
      {(view === 'olays' || (view === 'library' && material)) &&
        (material ? (
          <MaterialEditor
            key={material}
            id={material}
            onBack={() => view === 'library' ? go('library') : openOlay(olay ?? null)}
            onOpenOlay={(id) => openOlay(id)}
            onOpenSlot={onOpenSlot}
            onOpenMaterial={openMaterial}
          />
        ) : (
          <MaterialsOlays
            olayId={olay}
            onOpenOlay={openOlay}
            onOpenMaterial={openMaterial}
            onOpenSlot={onOpenSlot}
            onUpload={(id) => go('upload', { olay: id })}
          />
        ))}
      {view === 'shoots' && (
        <MaterialsShoots
          onOpenOlay={(id) => openOlay(id)}
          onOpenCalendar={(y) => navigate(`/content?tab=calendar&year=${y}`)}
        />
      )}
    </div>
  );
}
