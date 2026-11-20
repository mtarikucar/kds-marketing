import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import * as studio from '@/api/studio';
import type { BrakeState } from '@/api/postsPage';
import { useSession } from '@/auth/useSession';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Switch } from '@/components/ui';
import { can, canAny } from '@/lib/roles';
import { MaterialsCalendar } from '../materials/MaterialsCalendar';
import { PostingRules } from '../social/SettingsDialog';
import { StudioError, useStudioKey } from '../StudioShared';
import { useAccounts } from './AccountsSheet';
import { closedPlace, type PostsPlace } from './location';
import { useInvalidatePosts } from './queries';

/**
 * "Tüm paylaşımları durdur" (§2.9.3, D10): the organic lane's brake. Releasing it is the page's
 * `Sürdür`; engaging it reads the control's revision first (`studio.overview`), as no post read
 * carries it while the brake is off.
 */
function BrakeSwitch({ brake }: { brake: BrakeState | null }) {
  const { t } = useTranslation();
  const session = useSession();
  const key = useStudioKey();
  const refresh = useInvalidatePosts();
  const manage = can(session.data, 'social.manage');
  // The smallest window: only the control is read from the overview.
  const control = useQuery({
    queryKey: [...key, 'control'],
    queryFn: () => studio.overview({ from: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() }),
    enabled: manage && !brake,
    retry: false,
  });
  const set = useMutation({
    mutationFn: (engaged: boolean) => studio.brake(engaged, 'organic', engaged ? control.data!.control.revision : brake!.revision),
    onSuccess: refresh,
  });
  const on = !!brake;
  return (
    <div className="space-y-1 border-t border-border pt-3">
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <Switch
          checked={on}
          aria-label={t('postsPage.settings.brake')}
          disabled={!manage || set.isPending || (on ? !brake?.can_resume : !control.data)}
          onCheckedChange={(next) => set.mutate(next)}
        />
        <span className="font-medium">{t('postsPage.settings.brake')}</span>
      </label>
      <p className="text-xs text-muted-foreground">{t('postsPage.settings.brakeHelp')}</p>
      <StudioError error={set.error} />
    </div>
  );
}

/**
 * Ayarlar (design 2026-11-19 §2.9.3): one dialog, no tabs, three headed sections in one scroll:
 * Paylaşım kuralları (with the brake), Özel günler, Dosya kullanımı; `section=` scrolls to one.
 */
export function SettingsSheet({ place, go, brake }: { place: PostsPlace; go: (next: PostsPlace, options?: { replace?: boolean }) => void; brake: BrakeState | null }) {
  const { t } = useTranslation();
  const session = useSession();
  const social = canAny(session.data, ['social.work', 'social.manage']);
  const files = canAny(session.data, ['content.work', 'content.manage', 'materials.work']);
  const accounts = useAccounts(social);
  const year = place.year ?? Number(m.istanbulDay(new Date()).slice(0, 4));
  const close = () => go(closedPlace(place), { replace: true });
  useEffect(() => {
    if (!place.section) return;
    const id = window.setTimeout(() => document.getElementById(`settings-${place.section}`)?.scrollIntoView?.({ block: 'start' }), 50);
    return () => window.clearTimeout(id);
  }, [place.section]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
        <DialogTitle>{t('postsPage.settings.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('postsPage.settings.help')}</DialogDescription>
        <div className="min-w-0 space-y-8">
          {social && (
            <section id="settings-rules" aria-labelledby="settings-rules-title" className="scroll-mt-4 space-y-3">
              <h2 id="settings-rules-title" className="text-base font-semibold">{t('postsPage.settings.rules')}</h2>
              <PostingRules accounts={accounts.data} />
              <BrakeSwitch brake={brake} />
            </section>
          )}
          {files && (
            <section id="settings-days" aria-labelledby="settings-days-title" className="scroll-mt-4 space-y-3">
              <h2 id="settings-days-title" className="text-base font-semibold">{t('postsPage.settings.days')}</h2>
              <MaterialsCalendar part="days" year={year} onYear={(y) => go({ ...place, settings: true, year: y }, { replace: true })} />
            </section>
          )}
          {files && (
            <section id="settings-files" aria-labelledby="settings-files-title" className="scroll-mt-4 space-y-3">
              <h2 id="settings-files-title" className="text-base font-semibold">{t('postsPage.settings.files')}</h2>
              <MaterialsCalendar part="files" year={year} onYear={() => {}} />
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
