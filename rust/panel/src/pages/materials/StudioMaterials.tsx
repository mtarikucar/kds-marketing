import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import * as m from '@/api/materials';
import { MaterialEditor } from './MaterialEditor';
import { MaterialsCalendar } from './MaterialsCalendar';
import { MaterialsOlays } from './MaterialsOlays';
import { MaterialsShoots } from './MaterialsShoots';
import { MaterialsUpload } from './MaterialsUpload';
import { useMaterialsKey } from './MaterialsShared';

export const MATERIAL_VIEWS = ['upload', 'olays', 'calendar', 'shoots'] as const;
export type MaterialView = (typeof MATERIAL_VIEWS)[number];

/** Where the Materyaller tab is: its view and, in Olaylar, an olay or a material; in Takvim, a year. */
export function materialsHref(view: MaterialView, extra: Record<string, string> = {}): string {
  return `/studio?${new URLSearchParams({ tab: 'materials', view, ...extra }).toString()}`;
}

/**
 * The Materyaller tab of Growth Studio (spec §10): Yükle, Olaylar (with an olay's and a
 * material's detail), Takvim and Çekim listesi. Where it is lives in the address, so the phone's
 * back button walks back through it and Today links straight into it.
 */
export function StudioMaterials({ onOpenSlot }: { onOpenSlot: (id: string) => void }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: MaterialView = (MATERIAL_VIEWS as readonly string[]).includes(raw ?? '')
    ? (raw as MaterialView)
    : 'upload';
  const go = (next: MaterialView, extra: Record<string, string> = {}) =>
    setParams({ tab: 'materials', view: next, ...extra });
  const olay = params.get('olay') ?? undefined;
  const material = params.get('material') ?? undefined;
  const year = Number(params.get('year')) || Number(m.istanbulDay(new Date()).slice(0, 4));
  // The count on the Çekim listesi button: what waits to be shot or uploaded.
  const shoots = useQuery({ queryKey: [...key, 'shoots', 'open'], queryFn: () => m.shootList('open') });
  const openOlay = (id: string | null) => go('olays', id ? { olay: id } : {});
  const openMaterial = (id: string) => go('olays', { ...(olay ? { olay } : {}), material: id });
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
                  view === v ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
                }`}
              >
                {t(`materials.views.${v}`)}
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
      {view === 'olays' &&
        (material ? (
          <MaterialEditor
            key={material}
            id={material}
            onBack={() => openOlay(olay ?? null)}
            onOpenOlay={(id) => openOlay(id)}
            onOpenSlot={onOpenSlot}
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
      {view === 'calendar' && (
        <MaterialsCalendar year={year} onYear={(y) => go('calendar', { year: String(y) })} />
      )}
      {view === 'shoots' && (
        <MaterialsShoots
          onOpenOlay={(id) => openOlay(id)}
          onOpenCalendar={(y) => go('calendar', { year: String(y) })}
        />
      )}
    </div>
  );
}
