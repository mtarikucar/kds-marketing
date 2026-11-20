import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarHeart } from 'lucide-react';
import * as m from '@/api/materials';
import { filesAdd, specialDaySkip, type MaterialRef, type SpecialDayLine } from '@/api/postsPage';
import { Button, toast } from '@/components/ui';
import { ACCEPT, fileAccepted, uploadFile } from '../content/uploads';
import { MaterialsError } from '../materials/MaterialsShared';
import { usePostsMutation, useInvalidatePosts, useUndoFailed } from './queries';
import { dayWords, foundWords } from './words';

/** Uploads `files` one by one and hands them to `content.files_add` for `target`. */
export async function addFiles(files: File[], target: Parameters<typeof filesAdd>[0]['target']) {
  const ids: string[] = [];
  for (const file of files.filter(fileAccepted).slice(0, 10)) ids.push(await uploadFile(file, crypto.randomUUID()));
  if (!ids.length) throw new Error('no_accepted_file');
  return filesAdd({ request_key: crypto.randomUUID(), target, file_ids: ids });
}

/** A hidden file input and the button that opens it; the files picked go to `onFiles`. */
export function PickFiles({ label, onFiles, loading, variant = 'outline' }: { label: string; onFiles: (files: File[]) => void; loading?: boolean; variant?: 'outline' | 'ghost' | 'primary' }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size="sm" variant={variant} loading={loading} onClick={() => input.current?.click()}>{label}</Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={`pick-${label}`}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** "İzin ver" on a day's photos: each pending file's share set by the owner, at the read's revision. */
async function permitAll(files: MaterialRef[]) {
  for (const f of files) await m.materialPermission(f.material_id, f.expected_revision, 'shareable');
}

/** "Yine de kullan": the owner's quality tag on each of the day's pending photos. */
async function useAnyway(files: MaterialRef[]) {
  for (const f of files) await m.materialTag(f.material_id, f.expected_revision, { quality: 'publishable' });
}

/** One special day with no usable photo yet (§2.7.5): its line follows its files' state. */
function DayLine({ day }: { day: SpecialDayLine }) {
  const { t, i18n } = useTranslation();
  const refresh = useInvalidatePosts();
  const undoFailed = useUndoFailed();
  const name = day.name;
  // The day itself: a special day's window opens two weeks before it and a season's runs up to it.
  const date = dayWords(day.window_end, i18n.language);
  const target = { kind: 'special_day' as const, key: day.key, year: day.year };
  const add = usePostsMutation((files: File[]) => addFiles(files, target));
  const permit = usePostsMutation(() => permitAll(day.files.permit));
  const use = usePostsMutation(() => useAnyway(day.files.permit));
  const skip = usePostsMutation(() => specialDaySkip(day.key, day.year), (skipped) => {
    toast.success(t('postsPage.days.skipped', { day: name }), {
      duration: 10_000,
      action: {
        label: t('postsPage.days.undo'),
        onClick: () => {
          // The skip answered the entry it saved: the same entry, enabled again.
          void m.calendarSet({ ...skipped, enabled: true }).then(() => refresh(), undoFailed);
        },
      },
    });
  });
  const another = <PickFiles label={t('postsPage.days.another')} variant="ghost" loading={add.isPending} onFiles={(files) => add.mutate(files)} />;
  const state = day.files.state;
  let line: string;
  let actions: React.ReactNode = null;
  switch (state) {
    case 'analysing':
      line = t('postsPage.days.analysing', { day: name });
      break;
    case 'needs_permission':
      line = t('postsPage.days.needs_permission', { day: name, found: foundWords(t, day.files.found) });
      actions = <><Button size="sm" variant="outline" loading={permit.isPending} onClick={() => permit.mutate(undefined)}>{t('postsPage.actions.permit')}</Button>{day.can_add && another}</>;
      break;
    case 'unchecked':
      line = t('postsPage.days.unchecked', { day: name });
      actions = <><Button size="sm" variant="outline" loading={permit.isPending} onClick={() => permit.mutate(undefined)}>{t('postsPage.actions.permit')}</Button>{day.can_add && another}</>;
      break;
    case 'quality':
      line = t('postsPage.days.quality', { day: name });
      actions = <><Button size="sm" variant="outline" loading={use.isPending} onClick={() => use.mutate(undefined)}>{t('postsPage.actions.useAnyway')}</Button>{day.can_add && another}</>;
      break;
    default:
      line = t('postsPage.days.none', { day: name, date });
      actions = (
        <>
          {day.can_add && <PickFiles label={t('postsPage.days.add')} loading={add.isPending} onFiles={(files) => add.mutate(files)} />}
          {day.can_skip && <Button size="sm" variant="ghost" loading={skip.isPending} onClick={() => skip.mutate(undefined)}>{t('postsPage.days.skip')}</Button>}
        </>
      );
  }
  const error = add.error ?? permit.error ?? use.error ?? skip.error;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-xl border border-warning/40 bg-surface px-3.5 py-2.5 text-sm">
      <CalendarHeart aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-[1_1_15rem]">{line}</span>
      {actions}
      {error != null && <div className="basis-full"><MaterialsError error={error} /></div>}
    </li>
  );
}

/** The special-day lines (§2.2 item 4): at most three, the rest folded into one line. */
export function SpecialDays({ days, more, onMore }: { days: SpecialDayLine[]; more: number; onMore: () => void }) {
  const { t } = useTranslation();
  if (!days.length && !more) return null;
  return (
    <section aria-label={t('postsPage.days.region')} className="space-y-2">
      <ul className="space-y-2">{days.slice(0, 3).map((day) => <DayLine key={`${day.key}:${day.year}`} day={day} />)}</ul>
      {more > 0 && (
        <button type="button" className="min-h-9 px-1 text-sm text-primary underline underline-offset-4" onClick={onMore}>
          {t('postsPage.days.more', { count: more })}
        </button>
      )}
    </section>
  );
}
