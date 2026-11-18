import { useTranslation } from 'react-i18next';
import { istanbulDay } from '@/api/materials';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui';
import { MaterialsCalendar } from '../materials/MaterialsCalendar';
import { useContentPlace } from './location';

/** Behind the gear: the special days calendar and the materials rules, as they were in "Ayarlar". */
export function ContentSettings() {
  const { t } = useTranslation();
  const [place, go] = useContentPlace();
  const year = place.year ?? Number(istanbulDay(new Date()).slice(0, 4));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) go({ ...place, settings: undefined, year: undefined }, { replace: true }); }}>
      <DialogContent className="max-w-4xl">
        <DialogTitle>{t('content.settings.title')}</DialogTitle>
        <DialogDescription>{t('content.settings.help')}</DialogDescription>
        <MaterialsCalendar year={year} onYear={(y) => go({ ...place, settings: true, year: y }, { replace: true })} />
      </DialogContent>
    </Dialog>
  );
}
