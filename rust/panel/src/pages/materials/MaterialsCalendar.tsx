import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import { Badge } from '@/components/ui';
import {
  MaterialsError,
  MaterialsReadStatus,
  cardClass,
  fieldClass,
  formatRange,
  primaryClass,
  tapClass,
  useDecider,
  useMaterialsKey,
  useMaterialsMutation,
} from './MaterialsShared';

/** `text` as a whole number of days within `0..=max`, `null` when empty, `undefined` when invalid. */
function days(text: string, max: number): number | null | undefined {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
}

/** A calendar key: 1–40 of `[a-z0-9_]`. */
const KEY = /^[a-z0-9_]{1,40}$/;

/** The fields of an occasion of a year: its name, kind, window and lead, and whether it is on. */
function EntryForm({
  entry,
  isNew = false,
  onDone,
}: {
  entry: m.CalendarEntry;
  isNew?: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState(entry.key);
  const [name, setName] = useState(entry.name);
  const [kind, setKind] = useState<m.OccasionKind>(entry.kind);
  const [start, setStart] = useState(entry.window_start ?? '');
  const [end, setEnd] = useState(entry.window_end ?? '');
  const [lead, setLead] = useState(entry.lead_days === null ? '' : String(entry.lead_days));
  const [enabled, setEnabled] = useState(entry.enabled);
  const [problem, setProblem] = useState<'key' | 'name' | 'window' | 'lead' | null>(null);
  const save = useMaterialsMutation((row: m.CalendarEntry) => m.calendarSet(row), onDone);
  return (
    <form
      aria-label={isNew ? t('materials.calendar.add') : entry.name}
      className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (save.isPending) return;
        const leadDays = days(lead, 90);
        const p =
          isNew && !KEY.test(key)
            ? 'key'
            : !name.trim()
              ? 'name'
              : Boolean(start) !== Boolean(end) || (start && end && end < start)
                ? 'window'
                : leadDays === undefined
                  ? 'lead'
                  : null;
        setProblem(p);
        if (p) return;
        save.mutate({
          key,
          year: entry.year,
          name: name.trim(),
          kind,
          window_start: start || null,
          window_end: end || null,
          lead_days: leadDays ?? null,
          enabled,
        });
      }}
    >
      {isNew && (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('materials.calendar.key')}</span>
          <input className={fieldClass} value={key} onChange={(e) => setKey(e.target.value)} />
          <span className="text-xs text-muted-foreground">{t('materials.calendar.keyHelp')}</span>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('materials.calendar.name')}</span>
        <input className={fieldClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </label>
      {isNew && (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('materials.calendar.kind')}</span>
          <select className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value as m.OccasionKind)}>
            <option value="special_day">{t('materials.kind.special_day')}</option>
            <option value="season">{t('materials.kind.season')}</option>
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('materials.calendar.start')}</span>
        <input
          className={fieldClass}
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('materials.calendar.end')}</span>
        <input
          className={fieldClass}
          type="date"
          value={end}
          min={start || undefined}
          onChange={(e) => setEnd(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('materials.calendar.lead')}</span>
        <input
          className={fieldClass}
          inputMode="numeric"
          value={lead}
          placeholder={t('materials.calendar.leadDefault')}
          onChange={(e) => setLead(e.target.value)}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('materials.calendar.enabled')}
      </label>
      {problem && (
        <p role="alert" className="text-sm text-danger sm:col-span-2">
          {t(`materials.calendar.problem.${problem}`)}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button className={primaryClass} disabled={save.isPending}>
          {t('materials.calendar.save')}
        </button>
        <button type="button" className={tapClass} onClick={onDone}>
          {t('materials.calendar.cancel')}
        </button>
      </div>
      <div className="sm:col-span-2">
        <MaterialsError error={save.error} />
      </div>
    </form>
  );
}

function EntryRow({
  entry,
  edited,
  policy,
  decider,
}: {
  entry: m.CalendarEntry;
  edited: boolean;
  policy: m.MaterialPolicy;
  decider: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const dated = entry.window_start && entry.window_end;
  return (
    <li className="space-y-3 border-b border-border py-4" data-testid={`calendar-${entry.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{entry.name}</span>
        <span className="flex flex-wrap gap-1">
          <Badge tone="neutral">{t(`materials.kind.${entry.kind}`)}</Badge>
          {!entry.enabled && <Badge tone="danger">{t('materials.calendar.off')}</Badge>}
          {edited && <Badge tone="info">{t('materials.calendar.edited')}</Badge>}
        </span>
      </div>
      <p className="text-sm">
        {dated ? (
          formatRange(entry.window_start!, entry.window_end!, i18n.language)
        ) : (
          <Badge tone="warning">{t('materials.calendar.needsDates')}</Badge>
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {entry.lead_days === null
          ? t('materials.calendar.leadIsDefault', { days: policy.lead_days })
          : t('materials.calendar.leadIs', { days: entry.lead_days })}
      </p>
      {decider && !editing && (
        <button type="button" className={dated ? tapClass : primaryClass} onClick={() => setEditing(true)}>
          {dated ? t('materials.calendar.edit') : t('materials.calendar.enterDates')}
        </button>
      )}
      {editing && <EntryForm entry={entry} onDone={() => setEditing(false)} />}
    </li>
  );
}

/** The materials policy (D18): lead, reuse and recap days. */
function PolicyForm({ policy, decider }: { policy: m.MaterialPolicy; decider: boolean }) {
  const { t } = useTranslation();
  const [lead, setLead] = useState(String(policy.lead_days));
  const [reuse, setReuse] = useState(String(policy.reuse_days));
  const [recap, setRecap] = useState(String(policy.recap_days));
  const [invalid, setInvalid] = useState(false);
  const save = useMaterialsMutation((p: m.MaterialPolicy) => m.materialPolicySet(p));
  const field = (label: string, help: string, value: string, set: (v: string) => void) => (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <input
        className={fieldClass}
        inputMode="numeric"
        value={value}
        disabled={!decider}
        onChange={(e) => set(e.target.value)}
      />
      <span className="text-xs text-muted-foreground">{help}</span>
    </label>
  );
  return (
    <form
      className={cardClass}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!decider || save.isPending) return;
        const p = { lead_days: days(lead, 90), reuse_days: days(reuse, 365), recap_days: days(recap, 365) };
        const ok = Object.values(p).every((v) => typeof v === 'number');
        setInvalid(!ok);
        if (ok) save.mutate(p as m.MaterialPolicy);
      }}
    >
      <h4 className="font-semibold">{t('materials.policy.title')}</h4>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {field(t('materials.policy.lead'), t('materials.policy.leadHelp'), lead, setLead)}
        {field(t('materials.policy.reuse'), t('materials.policy.reuseHelp'), reuse, setReuse)}
        {field(t('materials.policy.recap'), t('materials.policy.recapHelp'), recap, setRecap)}
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-danger">
          {t('materials.policy.invalid')}
        </p>
      )}
      {decider ? (
        <button className={primaryClass} disabled={save.isPending}>
          {t('materials.policy.save')}
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">{t('materials.calendar.managerOnly')}</p>
      )}
      <MaterialsError error={save.error} />
    </form>
  );
}

/**
 * Takvim: a year's effective calendar (the Turkish defaults with the workspace's edits), each
 * occasion's window and lead, the dates the owner has yet to enter, and the materials policy.
 */
export function MaterialsCalendar({ year, onYear }: { year: number; onYear: (year: number) => void }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const [adding, setAdding] = useState(false);
  const calendar = useQuery({ queryKey: [...key, 'calendar', year], queryFn: () => m.calendarList(year) });
  const now = Number(m.istanbulDay(new Date()).slice(0, 4));
  const years = [now - 1, now, now + 1, now + 2];
  if (!years.includes(year)) years.push(year);
  const data = calendar.data;
  const undated = data?.entries.filter((e) => e.enabled && !e.window_start) ?? [];
  return (
    <div className="space-y-4" data-testid="materials-calendar">
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        <span>{t('materials.calendar.year')}</span>
        <select className={fieldClass} value={year} onChange={(e) => onYear(Number(e.target.value))}>
          {years.sort((a, b) => a - b).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <MaterialsReadStatus query={calendar} />
      {undated.length > 0 && (
        <p className="rounded-md bg-warning-subtle p-3 text-sm" role="status">
          {t('materials.calendar.undated', { count: undated.length, year })}
        </p>
      )}
      {data && (
        <>
          <ul className="grid grid-cols-1 gap-x-8 md:grid-cols-2" aria-label={t('materials.views.calendar')}>
            {data.entries.map((e) => (
              <EntryRow
                key={`${e.key}-${data.year}-${e.window_start}-${e.window_end}-${e.lead_days}-${e.enabled}-${e.name}`}
                entry={e}
                edited={data.rows.some((r) => r.key === e.key)}
                policy={data.policy}
                decider={decider}
              />
            ))}
          </ul>
          {decider &&
            (adding ? (
              <EntryForm
                isNew
                entry={{
                  key: '',
                  year: data.year,
                  name: '',
                  kind: 'special_day',
                  window_start: null,
                  window_end: null,
                  lead_days: null,
                  enabled: true,
                }}
                onDone={() => setAdding(false)}
              />
            ) : (
              <button type="button" className={tapClass} onClick={() => setAdding(true)}>
                {t('materials.calendar.add')}
              </button>
            ))}
          <PolicyForm
            key={`${data.policy.lead_days}-${data.policy.reuse_days}-${data.policy.recap_days}`}
            policy={data.policy}
            decider={decider}
          />
        </>
      )}
    </div>
  );
}
