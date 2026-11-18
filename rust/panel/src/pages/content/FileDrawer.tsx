import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui';
import { MaterialEditor } from '../materials/MaterialEditor';
import { placeHref, useContentPlace } from './location';
import { useOlayView } from './OlayView';

/** The contents of the open folder that use the file, from the folder's view. */
function UsedInContents({ id, folder }: { id: string; folder: string }) {
  const { t } = useTranslation();
  const view = useOlayView(folder);
  const row = view.data?.files?.find((f) => f.material.id === id);
  const contents = view.data?.contents ?? [];
  if (!row) return null;
  return (
    <section className="space-y-2 border-t border-border py-5">
      <h4 className="font-semibold">{t('content.file.usedInTitle')}</h4>
      {row.used_in.length ? (
        <ul className="space-y-1">
          {row.used_in.map((areaId) => (
            <li key={areaId}>
              <Link className="text-sm text-primary underline" to={placeHref({ olay: folder, content: areaId })}>
                {contents.find((c) => c.area.id === areaId)?.area.title ?? t('content.detail.label')}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('content.file.unused')}</p>
      )}
    </section>
  );
}

/**
 * The open file, over whatever the page shows: its analysis (description, group), its labels,
 * tags and the people it shows, its share permission and folder, where it was used, and its
 * erasure, each as the library's editor has them.
 */
export function FileDrawer({ id }: { id: string }) {
  const { t } = useTranslation();
  const [place, go] = useContentPlace();
  const navigate = useNavigate();
  return (
    <Sheet open onOpenChange={(open) => { if (!open) go({ ...place, file: undefined }, { replace: true }); }}>
      <SheetContent side="right" className="w-full max-w-xl sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('content.file.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('content.file.help')}</SheetDescription>
        </SheetHeader>
        <MaterialEditor
          key={id}
          id={id}
          onOpenOlay={(olay) => go({ olay })}
          onOpenSlot={(slot) => navigate(`/social?slot=${encodeURIComponent(slot)}`)}
          onOpenMaterial={(file) => go({ ...place, file })}
          usedIn={place.olay ? <UsedInContents id={id} folder={place.olay} /> : undefined}
        />
      </SheetContent>
    </Sheet>
  );
}
