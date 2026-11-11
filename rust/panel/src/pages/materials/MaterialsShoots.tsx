import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import { Badge } from '@/components/ui';
import {
  MaterialsError,
  MaterialsReadStatus,
  cardClass,
  fieldClass,
  formatDay,
  primaryClass,
  tapClass,
  useMaterialsKey,
  useMaterialsMutation,
} from './MaterialsShared';

/** Where a request's reason leads: its olay, or the calendar year whose dates are missing. */
export interface ShootLinks {
  onOpenOlay?: (id: string) => void;
  onOpenCalendar?: (year: number) => void;
}

/** One request of the çekim listesi, with its own "yapıldı" / "gerek yok" (its own pending state). */
export function ShootRow({ request, links = {} }: { request: m.ShootRequest; links?: ShootLinks }) {
  const { t, i18n } = useTranslation();
  const resolve = useMaterialsMutation((status: 'done' | 'dismissed') =>
    m.shootResolve(request.id, status),
  );
  const { reason } = request;
  const act = (status: 'done' | 'dismissed') => {
    if (!resolve.isPending) resolve.mutate(status);
  };
  return (
    <li className="space-y-3 border-b border-border py-4" data-testid={`shoot-${request.id}`}>
      <p className="break-words text-sm font-medium">{request.text}</p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t(`materials.shoot.reason.${reason.kind}`)}</span>
        <span>·</span>
        <span>{t('materials.shoot.week', { day: formatDay(request.week_start, i18n.language) })}</span>
        {request.status !== 'open' && (
          <Badge tone={request.status === 'done' ? 'success' : 'neutral'}>
            {t(`materials.shoot.status.${request.status}`)}
          </Badge>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {reason.kind === 'olay_upcoming' && links.onOpenOlay && (
          <button type="button" className={tapClass} onClick={() => links.onOpenOlay!(reason.olay_id)}>
            {t('materials.shoot.openOlay')}
          </button>
        )}
        {reason.kind === 'season_dates_missing' && links.onOpenCalendar && (
          <button type="button" className={tapClass} onClick={() => links.onOpenCalendar!(reason.year)}>
            {t('materials.shoot.openCalendar')}
          </button>
        )}
        {request.status === 'open' && (
          <>
            <button type="button" className={primaryClass} disabled={resolve.isPending} onClick={() => act('done')}>
              {t('materials.shoot.done')}
            </button>
            <button type="button" className={tapClass} disabled={resolve.isPending} onClick={() => act('dismissed')}>
              {t('materials.shoot.dismiss')}
            </button>
          </>
        )}
      </div>
      <MaterialsError error={resolve.error} />
    </li>
  );
}

/** Adds a request of the owner's own ("human:" keyed; replayed by its key on a retry). */
function AddRequest() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const requestKey = useRef<string | null>(null);
  const add = useMaterialsMutation(
    (value: string) => {
      requestKey.current ??= crypto.randomUUID();
      return m.shootRequest({ request_key: requestKey.current, text: value });
    },
    () => {
      setText('');
      requestKey.current = null;
    },
  );
  return (
    <form
      aria-label={t('materials.views.shoots')}
      className={cardClass}
      onSubmit={(e) => {
        e.preventDefault();
        if (!add.isPending && text.trim()) add.mutate(text.trim());
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">{t('materials.shoot.add')}</span>
        <textarea
          className={fieldClass}
          rows={2}
          maxLength={500}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            requestKey.current = null;
          }}
        />
      </label>
      <button className={primaryClass} disabled={add.isPending || !text.trim()}>
        {t('materials.shoot.addSubmit')}
      </button>
      <MaterialsError error={add.error} />
    </form>
  );
}

/**
 * Çekim listesi: what Studio asks to shoot or upload. This week's open requests first, then the
 * older ones; done and dismissed ones on request.
 */
export function MaterialsShoots(links: ShootLinks) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [closed, setClosed] = useState(false);
  const list = useQuery({
    queryKey: [...key, 'shoots', closed ? 'all' : 'open'],
    queryFn: () => m.shootList(closed ? 'all' : 'open'),
  });
  const monday = m.mondayOf(m.istanbulDay(new Date()));
  const byWeek = [...(list.data ?? [])].sort((a, b) =>
    a.status === b.status || (a.status !== 'open' && b.status !== 'open')
      ? b.week_start.localeCompare(a.week_start)
      : a.status === 'open'
        ? -1
        : 1,
  );
  const thisWeek = byWeek.filter((r) => r.status === 'open' && r.week_start >= monday);
  const older = byWeek.filter((r) => !thisWeek.includes(r));
  return (
    <div className="space-y-4" data-testid="materials-shoots">
      <AddRequest />
      <MaterialsReadStatus query={list} />
      <section aria-labelledby="shoots-this-week" className="space-y-2">
        <h3 id="shoots-this-week" className="font-semibold">
          {t('materials.shoot.thisWeek')}
        </h3>
        {list.data && thisWeek.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('materials.shoot.nothingThisWeek')}</p>
        )}
        <ul className="space-y-2">
          {thisWeek.map((r) => (
            <ShootRow key={r.id} request={r} links={links} />
          ))}
        </ul>
      </section>
      {older.length > 0 && (
        <section aria-labelledby="shoots-older" className="space-y-2">
          <h3 id="shoots-older" className="font-semibold">
            {t('materials.shoot.older')}
          </h3>
          <ul className="space-y-2">
            {older.map((r) => (
              <ShootRow key={r.id} request={r} links={links} />
            ))}
          </ul>
        </section>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
        {t('materials.shoot.showClosed')}
      </label>
    </div>
  );
}
