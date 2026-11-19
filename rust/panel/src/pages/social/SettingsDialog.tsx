import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronDown, Pencil } from 'lucide-react';
import { isApiError } from '@/api/client';
import * as p from '@/api/posts';
import type { SocialAccount } from '@/api/social';
import { QueryState } from '@/components/QueryState';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle, Switch } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { fieldClass, MaterialsError, useDecider } from '../materials/MaterialsShared';
import { usePostsKey, usePostsRead } from './data';
import { useSocialPlace } from './location';

/** The zones offered first; any IANA zone is taken. */
const ZONES = ['Europe/Istanbul', 'Europe/Berlin', 'Europe/London', 'Europe/Amsterdam', 'UTC'];

type Settings = p.PostsOut['settings'];
type Policy = p.PostingPolicy;

/** A number in `min..=max` (a comma is a decimal point), else `null`. */
export function num(value: string, min: number, max: number): number | null {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
}
const whole = (value: string, min: number, max: number) => {
  const n = num(value, min, max);
  return n !== null && Number.isInteger(n) ? n : null;
};
/** Hours given (two decimals at most matter) as whole minutes. */
const minutes = (h: number | null) => (h === null ? null : Math.round(h * 60));
const hours = (m: number) => String(m / 60);

interface FieldDef {
  key: string;
  label: string;
  /** What the input starts with, from the settings shown. */
  value: (s: Settings) => string;
  list?: string;
}

/**
 * One rule as a sentence, and what changes it: the one or two values it needs, read into a
 * whole new settings object from the latest read (`null` when a value is out of the server's
 * ranges, D21–D29).
 */
interface Rule {
  id: string;
  text: (s: Settings) => string;
  fields: FieldDef[];
  apply: (values: Record<string, string>, s: Settings) => Settings | null;
  note?: string;
}

const withPolicy = (s: Settings, policy: Partial<Policy>): Settings => ({ ...s, policy: { ...s.policy, ...policy } });

function rules(t: TFunction, lang: string): { main: { group: string; rules: Rule[] }[]; advanced: { group: string; rules: Rule[] }[] } {
  const n = (v: number) => formatNumber(v, lang);
  const h = (m: number) => new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', { maximumFractionDigits: 2 }).format(m / 60);
  const pad = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  const formatRule = (f: p.PostFormat): Rule => ({
    id: `format.${f}`,
    text: (s) => t('socialAccounts.rules.format', { format: t(`posts.format.${f}`), lead: h(s.policy.lead_minutes[f]), grace: h(s.policy.grace_minutes[f]) }),
    fields: [
      { key: 'lead', label: `${t(`posts.format.${f}`)} · ${t('posts.settings.lead')}`, value: (s) => hours(s.policy.lead_minutes[f]) },
      { key: 'grace', label: `${t(`posts.format.${f}`)} · ${t('posts.settings.grace')}`, value: (s) => hours(s.policy.grace_minutes[f]) },
    ],
    apply: (v, s) => {
      const lead = minutes(num(v.lead, 0, s.policy.horizon_days * 24));
      const grace = minutes(num(v.grace, 0, 24));
      if (lead === null || grace === null) return null;
      return withPolicy(s, { lead_minutes: { ...s.policy.lead_minutes, [f]: lead }, grace_minutes: { ...s.policy.grace_minutes, [f]: grace } });
    },
  });
  return {
    main: [
      {
        group: t('socialAccounts.rules.limits'),
        rules: [
          {
            id: 'feed',
            text: (s) => t('socialAccounts.rules.feed', { count: s.policy.feed_cap.per_day, hours: h(s.policy.feed_cap.spacing_minutes) }),
            fields: [
              { key: 'cap', label: t('posts.settings.feedCap'), value: (s) => String(s.policy.feed_cap.per_day) },
              { key: 'spacing', label: t('posts.settings.feedSpacing'), value: (s) => hours(s.policy.feed_cap.spacing_minutes) },
            ],
            apply: (v, s) => {
              const cap = whole(v.cap, 1, 100);
              const spacing = minutes(num(v.spacing, 0, 24));
              return cap === null || spacing === null ? null : withPolicy(s, { feed_cap: { per_day: cap, spacing_minutes: spacing } });
            },
          },
          {
            id: 'story',
            text: (s) => t('socialAccounts.rules.story', { count: s.policy.story_cap.per_day, minutes: n(s.policy.story_cap.spacing_minutes) }),
            fields: [
              { key: 'cap', label: t('posts.settings.storyCap'), value: (s) => String(s.policy.story_cap.per_day) },
              { key: 'spacing', label: t('posts.settings.storySpacing'), value: (s) => String(s.policy.story_cap.spacing_minutes) },
            ],
            apply: (v, s) => {
              const cap = whole(v.cap, 1, 100);
              const spacing = whole(v.spacing, 0, 1440);
              return cap === null || spacing === null ? null : withPolicy(s, { story_cap: { per_day: cap, spacing_minutes: spacing } });
            },
            note: t('posts.settings.storyNote'),
          },
          {
            id: 'tiktok',
            text: (s) => t('socialAccounts.rules.tiktok', { count: s.policy.tiktok_video_cap.per_day }),
            fields: [{ key: 'cap', label: t('posts.settings.tiktokCap'), value: (s) => String(s.policy.tiktok_video_cap.per_day) }],
            apply: (v, s) => {
              const cap = whole(v.cap, 1, 100);
              return cap === null ? null : withPolicy(s, { tiktok_video_cap: { ...s.policy.tiktok_video_cap, per_day: cap } });
            },
          },
        ],
      },
      {
        group: t('socialAccounts.rules.calendar'),
        rules: [
          {
            id: 'quiet',
            text: (s) => (s.policy.quiet_start_hour === s.policy.quiet_end_hour
              ? t('socialAccounts.rules.noQuiet')
              : t('socialAccounts.rules.quiet', { from: pad(s.policy.quiet_start_hour), until: pad(s.policy.quiet_end_hour) })),
            fields: [
              { key: 'from', label: t('posts.settings.quietFrom'), value: (s) => String(s.policy.quiet_start_hour) },
              { key: 'until', label: t('posts.settings.quietUntil'), value: (s) => String(s.policy.quiet_end_hour) },
            ],
            apply: (v, s) => {
              const from = whole(v.from, 0, 23);
              const until = whole(v.until, 0, 23);
              return from === null || until === null ? null : withPolicy(s, { quiet_start_hour: from, quiet_end_hour: until });
            },
          },
          {
            id: 'tz',
            text: (s) => t('socialAccounts.rules.tz', { tz: s.tz }),
            fields: [{ key: 'tz', label: t('posts.settings.tz'), value: (s) => s.tz, list: 'posting-zones' }],
            apply: (v, s) => (v.tz.trim() ? { ...s, tz: v.tz.trim() } : null),
          },
        ],
      },
    ],
    advanced: [
      { group: t('socialAccounts.rules.formats'), rules: p.POST_FORMATS.map(formatRule) },
      {
        group: t('socialAccounts.rules.planning'),
        rules: [
          {
            id: 'floor',
            text: (s) => t('socialAccounts.rules.floor', { count: s.policy.floor_days }),
            fields: [{ key: 'floor', label: t('posts.settings.floor'), value: (s) => String(s.policy.floor_days) }],
            apply: (v, s) => {
              const floor = whole(v.floor, 1, 90);
              return floor === null ? null : withPolicy(s, { floor_days: floor });
            },
          },
          {
            id: 'debounce',
            text: (s) => t('socialAccounts.rules.debounce', { count: s.policy.debounce_minutes }),
            fields: [{ key: 'debounce', label: t('posts.settings.debounce'), value: (s) => String(s.policy.debounce_minutes) }],
            apply: (v, s) => {
              const debounce = whole(v.debounce, 0, 1440);
              return debounce === null ? null : withPolicy(s, { debounce_minutes: debounce });
            },
          },
          {
            id: 'horizon',
            text: (s) => t('socialAccounts.rules.horizon', { count: s.policy.horizon_days }),
            fields: [{ key: 'horizon', label: t('posts.settings.horizon'), value: (s) => String(s.policy.horizon_days) }],
            // A format's lead may not reach past the horizon (the server's rule).
            apply: (v, s) => {
              const horizon = whole(v.horizon, 1, 90);
              if (horizon === null || p.POST_FORMATS.some((f) => s.policy.lead_minutes[f] > horizon * 24 * 60)) return null;
              return withPolicy(s, { horizon_days: horizon });
            },
          },
        ],
      },
    ],
  };
}

/**
 * What the dialog says of approval, true of the accounts in front of the person: none of them
 * waits for one, every one does, or which do (named when three or fewer, else counted).
 */
export function approvalHelp(t: TFunction, accounts: SocialAccount[]): string {
  const waiting = accounts.filter((a) => a.requires_human_approval);
  if (!waiting.length) return t('posts.settings.help.none');
  if (waiting.length === accounts.length) return t('posts.settings.help.all');
  if (waiting.length > 3) return t('posts.settings.help.many', { n: waiting.length });
  return t('posts.settings.help.some', { count: waiting.length, accounts: waiting.map((a) => a.name).join(', ') });
}

/** The settings as the server takes them: the policy, the zone and the scheduler choice. */
const body = (s: Settings): p.PostingSettings => ({ tz: s.tz, policy: s.policy, provider_scheduling: s.provider_scheduling === true });

/**
 * A save of one rule: the settings are read again first, so the whole object sent is the latest
 * with this one change. When they changed since the dialog showed them (another person, another
 * tab), nothing is sent: the new values show and the person decides again.
 */
function useSave() {
  const client = useQueryClient();
  const key = usePostsKey();
  return async (shown: Settings, change: (fresh: Settings) => Settings | null): Promise<'saved' | 'stale' | 'invalid'> => {
    const fresh = await client.fetchQuery({ queryKey: key, queryFn: () => p.postsList({ from: key[4] }), staleTime: 0 });
    if (fresh.settings.revision !== shown.revision) return 'stale';
    const next = change(fresh.settings);
    if (!next) return 'invalid';
    const saved = await p.postingPolicySet(body(next));
    client.setQueryData<p.PostsOut>(key, (old) => (old ? { ...old, settings: { ...old.settings, ...saved } } : old));
    return 'saved';
  };
}

function Outcome({ outcome, error, invalid }: { outcome: string | null; error: unknown; invalid: string }) {
  const { t } = useTranslation();
  const tzRefused = isApiError(error) && error.details.field === 'tz';
  return (
    <>
      {outcome === 'invalid' && <p role="alert" className="basis-full text-sm text-danger">{invalid}</p>}
      {outcome === 'stale' && <p role="alert" className="basis-full text-sm text-warning">{t('socialAccounts.rules.stale')}</p>}
      {tzRefused ? <p role="alert" className="basis-full rounded-md bg-danger-subtle p-3 text-sm">{t('posts.settings.invalidTz')}</p> : <div className="basis-full"><MaterialsError error={error} /></div>}
    </>
  );
}

/** A rule's sentence and, for a decider, its own small edit that saves on its own. */
function RuleLine({ rule, settings, decider, editing, onEdit, onClose }: { rule: Rule; settings: Settings; decider: boolean; editing: boolean; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const save = useSave();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const text = rule.text(settings);
  const open = () => {
    setValues(Object.fromEntries(rule.fields.map((f) => [f.key, f.value(settings)])));
    setOutcome(null);
    setError(null);
    onEdit();
  };
  const submit = async () => {
    if (busy) return;
    if (!rule.apply(values, settings)) { setOutcome('invalid'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await save(settings, (fresh) => rule.apply(values, fresh));
      setOutcome(result);
      if (result === 'saved') onClose();
    } catch (e) {
      setOutcome(null);
      setError(e);
    }
    setBusy(false);
  };
  return (
    <li className="min-w-0 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 text-sm">{text}</p>
        {decider && !editing && (
          <Button size="sm" variant="ghost" aria-label={t('socialAccounts.rules.editOf', { rule: text })} onClick={open} className="shrink-0">
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            {t('socialAccounts.rules.edit')}
          </Button>
        )}
      </div>
      {rule.note && <p className="mt-1 text-xs text-muted-foreground">{rule.note}</p>}
      {outcome === 'saved' && !editing && <p role="status" className="mt-1 text-xs text-success">{t('posts.settings.saved')}</p>}
      {editing && (
        <form noValidate aria-label={text} className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface-muted/50 p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {rule.fields.map((f, i) => (
            <label key={f.key} className="flex min-w-0 flex-[1_1_10rem] flex-col gap-1 text-xs">
              <span>{f.label}</span>
              <input className={fieldClass} inputMode={f.list ? undefined : 'decimal'} list={f.list} autoFocus={i === 0} value={values[f.key] ?? ''} onChange={(e) => { setOutcome(null); setValues((v) => ({ ...v, [f.key]: e.target.value })); }} />
            </label>
          ))}
          {rule.fields.some((f) => f.list) && <datalist id="posting-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>}
          <Button size="sm" type="submit" loading={busy}>{t('common.save')}</Button>
          <Button size="sm" variant="ghost" type="button" onClick={onClose}>{t('common.cancel')}</Button>
          <Outcome outcome={outcome} error={error} invalid={t(rule.id === 'horizon' ? 'socialAccounts.rules.horizonInvalid' : 'posts.settings.invalid')} />
        </form>
      )}
    </li>
  );
}

/** Whether posts are left with the platform's own scheduler: a switch that saves on its own. */
function ProviderScheduling({ settings, decider }: { settings: Settings; decider: boolean }) {
  const { t } = useTranslation();
  const save = useSave();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const on = settings.provider_scheduling === true;
  return (
    <li className="min-w-0 space-y-1 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <p className="min-w-0 flex-1 text-sm">{t(on ? 'socialAccounts.rules.providerOn' : 'socialAccounts.rules.providerOff')}</p>
        <Switch
          checked={on}
          disabled={!decider || busy}
          aria-label={t('posts.settings.providerScheduling')}
          onCheckedChange={async (next) => {
            setBusy(true);
            setError(null);
            try {
              setOutcome(await save(settings, (fresh) => ({ ...fresh, provider_scheduling: next })));
            } catch (e) {
              setOutcome(null);
              setError(e);
            }
            setBusy(false);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('posts.settings.providerSchedulingHelp')}</p>
      {outcome === 'saved' && <p role="status" className="text-xs text-success">{t('posts.settings.saved')}</p>}
      <div className="flex flex-wrap"><Outcome outcome={outcome} error={error} invalid={t('posts.settings.invalid')} /></div>
    </li>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

/**
 * Behind the gear: the posting rules as a few readable sentences, grouped as before (daily
 * limits; calendar and time), each with its own small edit; the rarely touched values (each
 * format's lead and grace, the floor, the settling time, the horizon, the platform's scheduler)
 * folded under "Gelişmiş". An owner or manager with `social.work` changes them in person;
 * anyone else reads them (spec D21, D24–D29, D56).
 */
export function SettingsDialog({ accounts }: { accounts: SocialAccount[] }) {
  const { t, i18n } = useTranslation();
  const [place, go] = useSocialPlace();
  const posts = usePostsRead(true);
  const decider = useDecider('social.work');
  const [editing, setEditing] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const settings = posts.data?.settings;
  const groups = rules(t, i18n.language);
  const line = (rule: Rule) => settings && (
    <RuleLine key={rule.id} rule={rule} settings={settings} decider={decider} editing={editing === rule.id} onEdit={() => setEditing(rule.id)} onClose={() => setEditing(null)} />
  );
  const paused = accounts.filter((a) => settings?.paused_capability_ids?.includes(a.capability_id) ?? a.paused);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) go({ ...place, settings: undefined }, { replace: true }); }}>
      <DialogContent className="max-w-2xl" data-testid="posting-settings">
        <DialogTitle>{t('posts.settings.title')}</DialogTitle>
        <DialogDescription>{approvalHelp(t, accounts)}</DialogDescription>
        <QueryState query={posts} keepOnError>
          {settings && (
            <div className="min-w-0 space-y-5">
              {groups.main.map((g) => <Group key={g.group} title={g.group}>{g.rules.map(line)}</Group>)}
              {paused.length > 0 && (
                <p className="text-sm text-muted-foreground">{t('socialAccounts.rules.paused', { accounts: paused.map((a) => a.name).join(', ') })}</p>
              )}
              <div className="border-t border-border pt-3">
                <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((o) => !o)}
                  className="flex min-h-11 w-full items-center gap-1 rounded-md text-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', !advanced && '-rotate-90')} />
                  {t('socialAccounts.rules.advanced')}
                </button>
                {advanced && (
                  <div className="space-y-5 pt-2">
                    {groups.advanced.map((g) => (
                      <Group key={g.group} title={g.group}>
                        {g.rules.map(line)}
                        {g === groups.advanced[1] && <ProviderScheduling settings={settings} decider={decider} />}
                      </Group>
                    ))}
                  </div>
                )}
              </div>
              {!decider && <p className="text-sm text-muted-foreground">{t('posts.settings.managerOnly')}</p>}
            </div>
          )}
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}
