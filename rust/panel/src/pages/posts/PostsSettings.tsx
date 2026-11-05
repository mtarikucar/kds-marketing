import { useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isApiError } from '@/api/client';
import * as p from '@/api/posts';
import {
  MaterialsError,
  cardClass,
  fieldClass,
  primaryClass,
  useDecider,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { usePosts } from './PostsShared';

/** The zones offered first; any IANA zone is taken. */
const ZONES = ['Europe/Istanbul', 'Europe/Berlin', 'Europe/London', 'Europe/Amsterdam', 'UTC'];

type Draft = Record<string, string>;

const hours = (minutes: number) => String(minutes / 60);

function draftOf(s: p.PostingSettings): Draft {
  const d: Draft = { tz: s.tz };
  for (const f of p.POST_FORMATS) {
    d[`lead.${f}`] = hours(s.policy.lead_minutes[f]);
    d[`grace.${f}`] = hours(s.policy.grace_minutes[f]);
  }
  d.feedCap = String(s.policy.feed_cap.per_day);
  d.feedSpacing = hours(s.policy.feed_cap.spacing_minutes);
  d.storyCap = String(s.policy.story_cap.per_day);
  d.storySpacing = String(s.policy.story_cap.spacing_minutes);
  d.tiktokCap = String(s.policy.tiktok_video_cap.per_day);
  d.quietFrom = String(s.policy.quiet_start_hour);
  d.quietUntil = String(s.policy.quiet_end_hour);
  d.floor = String(s.policy.floor_days);
  d.debounce = String(s.policy.debounce_minutes);
  d.horizon = String(s.policy.horizon_days);
  return d;
}

/** A number in `min..=max` with at most two decimals (hours), else `null`. */
function num(value: string, min: number, max: number): number | null {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** The settings `d` says, or `null` when a value is out of the server's ranges (D21–D29). */
function settingsOf(d: Draft, keep: p.PostingSettings): p.PostingSettings | null {
  const minutes = (h: number | null) => (h === null ? null : Math.round(h * 60));
  const horizon = num(d.horizon, 1, 90);
  const whole = (v: string, min: number, max: number) => {
    const n = num(v, min, max);
    return n !== null && Number.isInteger(n) ? n : null;
  };
  const lead = {} as p.FormatMinutes;
  const grace = {} as p.FormatMinutes;
  for (const f of p.POST_FORMATS) {
    const l = minutes(num(d[`lead.${f}`], 0, (horizon ?? 90) * 24));
    const g = minutes(num(d[`grace.${f}`], 0, 24));
    if (l === null || g === null) return null;
    lead[f] = l;
    grace[f] = g;
  }
  const feedSpacing = minutes(num(d.feedSpacing, 0, 24));
  const values = {
    feedCap: whole(d.feedCap, 1, 100),
    storyCap: whole(d.storyCap, 1, 100),
    storySpacing: whole(d.storySpacing, 0, 1440),
    tiktokCap: whole(d.tiktokCap, 1, 100),
    quietFrom: whole(d.quietFrom, 0, 23),
    quietUntil: whole(d.quietUntil, 0, 23),
    floor: whole(d.floor, 1, 90),
    debounce: whole(d.debounce, 0, 1440),
    horizon: horizon !== null && Number.isInteger(horizon) ? horizon : null,
  };
  if (feedSpacing === null || Object.values(values).some((v) => v === null) || !d.tz.trim()) {
    return null;
  }
  const v = values as Record<keyof typeof values, number>;
  return {
    tz: d.tz.trim(),
    policy: {
      ...keep.policy,
      lead_minutes: lead,
      grace_minutes: grace,
      feed_cap: { per_day: v.feedCap, spacing_minutes: feedSpacing },
      story_cap: { per_day: v.storyCap, spacing_minutes: v.storySpacing },
      tiktok_video_cap: { ...keep.policy.tiktok_video_cap, per_day: v.tiktokCap },
      quiet_start_hour: v.quietFrom,
      quiet_end_hour: v.quietUntil,
      floor_days: v.floor,
      debounce_minutes: v.debounce,
      horizon_days: v.horizon,
    },
  };
}

function SettingsForm({ settings, decider }: { settings: p.PostingSettings; decider: boolean }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMaterialsMutation(
    (s: p.PostingSettings) => p.postingPolicySet(s),
    () => setSaved(true),
  );
  const set = (key: string) => (e: ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: e.target.value }));
  };
  const field = (key: string, label: string, help?: string) => (
    <label className="flex flex-col gap-1 text-sm" key={key}>
      <span>{label}</span>
      <input
        className={fieldClass}
        inputMode="decimal"
        value={draft[key]}
        disabled={!decider}
        onChange={set(key)}
      />
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </label>
  );
  const tzRefused = isApiError(save.error) && save.error.details.field === 'tz';
  return (
    <form
      className={cardClass}
      noValidate
      data-testid="posting-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (!decider || save.isPending) return;
        const next = settingsOf(draft, settings);
        setInvalid(next === null);
        if (next) save.mutate(next);
      }}
    >
      <h3 className="font-semibold">{t('posts.settings.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('posts.settings.help')}</p>
      <div className="max-w-3xl overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">{t('posts.settings.format')}</th>
              <th className="px-3 py-2.5 font-medium">{t('posts.settings.lead')}</th>
              <th className="px-3 py-2.5 font-medium">{t('posts.settings.grace')}</th>
            </tr>
          </thead>
          <tbody>
            {p.POST_FORMATS.map((f) => (
              <tr key={f} className="border-t border-border">
                <th scope="row" className="px-3 py-2.5 font-normal">
                  {t(`posts.format.${f}`)}
                </th>
                {(['lead', 'grace'] as const).map((kind) => (
                  <td key={kind} className="px-3 py-2.5">
                    <input
                      aria-label={`${t(`posts.format.${f}`)} · ${t(`posts.settings.${kind}`)}`}
                      className={fieldClass}
                      inputMode="decimal"
                      value={draft[`${kind}.${f}`]}
                      disabled={!decider}
                      onChange={set(`${kind}.${f}`)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t('posts.settings.storyNote')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {field('feedCap', t('posts.settings.feedCap'))}
        {field('feedSpacing', t('posts.settings.feedSpacing'))}
        {field('storyCap', t('posts.settings.storyCap'))}
        {field('storySpacing', t('posts.settings.storySpacing'))}
        {field('tiktokCap', t('posts.settings.tiktokCap'))}
        {field('quietFrom', t('posts.settings.quietFrom'))}
        {field('quietUntil', t('posts.settings.quietUntil'))}
        {field('floor', t('posts.settings.floor'), t('posts.settings.floorHelp'))}
        {field('debounce', t('posts.settings.debounce'), t('posts.settings.debounceHelp'))}
        {field('horizon', t('posts.settings.horizon'))}
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('posts.settings.tz')}</span>
          <input
            className={fieldClass}
            list="posting-zones"
            value={draft.tz}
            disabled={!decider}
            onChange={set('tz')}
          />
          <datalist id="posting-zones">
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-danger">
          {t('posts.settings.invalid')}
        </p>
      )}
      {decider ? (
        <button className={primaryClass} disabled={save.isPending}>
          {t('posts.settings.save')}
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">{t('posts.settings.managerOnly')}</p>
      )}
      {saved && !save.isPending && (
        <p role="status" className="text-sm text-success">
          {t('posts.settings.saved')}
        </p>
      )}
      {tzRefused ? (
        <p role="alert" className="rounded-md bg-danger-subtle p-3 text-sm">
          {t('posts.settings.invalidTz')}
        </p>
      ) : (
        <MaterialsError error={save.error} />
      )}
    </form>
  );
}

/**
 * Paylaşım ayarları (spec D21, D24–D29, D56): the leads and graces per format in hours, the
 * protective caps and spacing, quiet hours, the floor, the settling time, the horizon and the
 * zone they are read in. An owner or manager changes them in person; anyone else reads them.
 */
export function PostsSettings() {
  const posts = usePosts();
  const decider = useDecider();
  const settings = posts.data?.settings;
  return (
    <div data-testid="posts-settings">
      <MaterialsError error={posts.error} />
      {settings && (
        <SettingsForm settings={settings} decider={decider} />
      )}
    </div>
  );
}
