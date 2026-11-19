import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { isApiError } from '@/api/client';
import { createTask } from '@/api/research';
import type { Area, Brief, ResearchTask } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, cn, Input, Textarea, toast } from '@/components/ui';
import { lines, useDraftKey, useInFlight } from '@/lib/leads';
import { selectClass } from '../InboxShared';
import { ListInput, useLeadsRefresh } from '../LeadsShared';
import { useTaskCopy, type TaskCopy, type TaskCopyKey } from './copy';
import { languageName, placeText, taskName } from './words';

/** Today's defaults for a new one-off task: what the old form started with. */
const TARGET = '20';
const DAILY_CAP = '10';
/** The languages offered by name; any other tag the server takes is typed under "another". */
const LANGUAGES = ['tr', 'en', 'de', 'ar', 'ru'] as const;
const OTHER = 'other';

interface Draft {
  sectors: string[];
  areas: string[];
  target: string;
  cap: string;
  signals: string;
  exclusions: string;
  segment: string;
  size: string;
  /** `''` any, a tag of [`LANGUAGES`], or [`OTHER`] with `code`. */
  language: string;
  code: string;
  note: string;
}

const EMPTY: Draft = { sectors: [], areas: [], target: TARGET, cap: DAILY_CAP, signals: '', exclusions: '', segment: '', size: '', language: '', code: '', note: '' };

/** A task's brief as a draft to start from; the pace stays today's defaults. */
function draftOf(brief: Brief): Draft {
  const known = brief.language && (LANGUAGES as readonly string[]).includes(brief.language);
  return {
    ...EMPTY,
    sectors: brief.sectors,
    areas: brief.areas.map(placeText),
    signals: brief.signals.join('\n'),
    exclusions: brief.exclusions.join('\n'),
    segment: brief.segment_key ?? '',
    size: brief.size_hint,
    language: brief.language ? (known ? brief.language : OTHER) : '',
    code: known ? '' : brief.language ?? '',
    note: brief.note,
  };
}

/** A place typed as `city` or `city / district`. */
function areaOf(text: string): Area {
  const [city, ...rest] = text.split('/');
  const district = rest.join('/').trim();
  return { city: city.trim(), district: district || null };
}

/** The fields the server names in a refusal, by where the composer shows them. */
const UP_FRONT = ['sectors', 'areas', 'target_count', 'daily_cap'];

/** The composer's words for the server's refusal of one field (`VALIDATION {field, reason}`). */
function refusal(copy: TaskCopy, err: unknown): { field: string; text: string } | null {
  if (!isApiError(err) || err.code !== 'VALIDATION') return null;
  const field = typeof err.details.field === 'string' ? err.details.field : '';
  const reason = err.details.reason;
  const key: TaskCopyKey | null =
    field === 'sectors' ? (reason === 'count' ? 'eSectorsCount' : 'eItemLength')
    : field === 'areas' ? (reason === 'count' ? 'eAreasCount' : 'ePlaceLength')
    : field === 'signals' || field === 'exclusions' ? (reason === 'count' ? 'eListCount' : 'eItemLength')
    : field === 'size_hint' ? 'eSize'
    : field === 'language' ? 'eLanguage'
    : field === 'note' ? 'eNote'
    : field === 'segment_key' ? 'eSegment'
    : field === 'target_count' || field === 'daily_cap' ? 'eRange'
    : null;
  return key ? { field, text: copy(key) } : null;
}

function Field({ label, help, error, children, id }: { label: string; help?: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      {children}
      {error ? <p id={`${id}-error`} className="text-xs text-danger">{error}</p> : help ? <p id={`${id}-help`} className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/**
 * A one-off research task in a few words: what to look for and where, with the target and the
 * daily cap prefilled in one sentence; the rest of the brief behind "more details". Every value
 * the server takes can be set; its limits are its own, and a refusal is said at its field.
 */
export function Composer({
  tasks,
  segments,
  onDone,
}: {
  /** The tasks whose brief a new one may start from. */
  tasks: ResearchTask[];
  segments: ReadonlyMap<string, string>;
  onDone: (created?: string) => void;
}) {
  const copy = useTaskCopy();
  const refresh = useLeadsRefresh();
  const draftKey = useDraftKey();
  const guard = useInFlight();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // Remounts the comma lists when a brief is taken over (they keep the text as typed).
  const [seed, setSeed] = useState(0);
  const [more, setMore] = useState(false);
  const [from, setFrom] = useState('');
  const set = <K extends keyof Draft>(name: K, value: Draft[K]) => setDraft((d) => ({ ...d, [name]: value }));
  const language = draft.language === OTHER ? draft.code.trim() : draft.language;
  const brief: Brief = {
    segment_key: draft.segment || null,
    sectors: draft.sectors,
    areas: draft.areas.map(areaOf),
    signals: lines(draft.signals),
    exclusions: lines(draft.exclusions),
    size_hint: draft.size.trim(),
    language: language || null,
    note: draft.note.trim(),
  };
  const target = Number(draft.target);
  const cap = Number(draft.cap);
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= 500;
  const valid = brief.sectors.length > 0 && brief.areas.length > 0 && brief.areas.every((a) => a.city) && whole(target) && whole(cap);
  const create = useMutation({
    mutationFn: () => {
      const input = { brief, target_count: target, daily_cap: cap };
      return createTask({ ...input, request_key: draftKey.keyFor(input) });
    },
    onSuccess: async (out) => {
      toast.success(copy('created'));
      draftKey.reset();
      await refresh();
      onDone(out.task.id);
    },
    onError: (err) => {
      const r = refusal(copy, err);
      if (r && !UP_FRONT.includes(r.field)) setMore(true);
    },
  });
  const refused = refusal(copy, create.error);
  const errorAt = (field: string) => (refused?.field === field ? refused.text : undefined);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => create.mutate(undefined, { onSettled: release }));
  };
  const startFrom = (id: string) => {
    setFrom(id);
    const task = tasks.find((x) => x.id === id);
    setDraft(task ? draftOf(task.brief) : EMPTY);
    setSeed((n) => n + 1);
    if (task && (task.brief.signals.length || task.brief.exclusions.length || task.brief.size_hint || task.brief.language || task.brief.segment_key)) setMore(true);
  };
  const segmentOptions = [...segments.entries()];
  if (draft.segment && !segments.has(draft.segment)) segmentOptions.push([draft.segment, draft.segment]);
  const number = 'h-8 w-16 px-2 text-center tabular-nums';
  return (
    <div className="min-w-0 rounded-lg border border-primary/30 bg-surface p-4 shadow-xs">
      <form className="space-y-4" onSubmit={submit} aria-label={copy('composer')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium">{copy('composer')}</h2>
          {tasks.length > 0 && (
            <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <span className="shrink-0">{copy('startFrom')}</span>
              <select className={cn(selectClass, 'w-auto min-w-0 max-w-[14rem] py-1 text-foreground')} value={from} onChange={(e) => startFrom(e.target.value)}>
                <option value="">{copy('startEmpty')}</option>
                {tasks.map((task) => <option key={task.id} value={task.id}>{taskName(copy, task, segments)}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="research-sought" label={copy('soughtField')} help={copy('commaHelp')} error={errorAt('sectors')}>
            <ListInput key={`s${seed}`} id="research-sought" autoComplete="off" placeholder={copy('soughtHint')} value={draft.sectors}
              aria-invalid={!!errorAt('sectors')} aria-describedby={errorAt('sectors') ? 'research-sought-error' : 'research-sought-help'}
              onChange={(items) => set('sectors', items)} />
          </Field>
          <Field id="research-where" label={copy('whereField')} help={copy('whereHelp')} error={errorAt('areas')}>
            <ListInput key={`a${seed}`} id="research-where" autoComplete="off" placeholder={copy('whereHint')} value={draft.areas}
              aria-invalid={!!errorAt('areas')} aria-describedby={errorAt('areas') ? 'research-where-error' : 'research-where-help'}
              onChange={(items) => set('areas', items)} />
          </Field>
        </div>
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span>{copy('paceBefore')}</span>
            <Input type="number" inputMode="numeric" min={1} max={500} aria-label={copy('targetField')} className={number}
              aria-invalid={!!errorAt('target_count')} value={draft.target} onChange={(e) => set('target', e.target.value)} />
            <span>{copy('paceMiddle')}</span>
            <Input type="number" inputMode="numeric" min={1} max={500} aria-label={copy('capField')} className={number}
              aria-invalid={!!errorAt('daily_cap')} value={draft.cap} onChange={(e) => set('cap', e.target.value)} />
            <span>{copy('paceAfter')}</span>
          </p>
          {(errorAt('target_count') || errorAt('daily_cap')) && <p className="text-xs text-danger">{copy('eRange')}</p>}
        </div>
        <div>
          <button type="button" aria-expanded={more} aria-controls="research-more" onClick={() => setMore((v) => !v)}
            className="inline-flex min-h-8 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', more && 'rotate-180')} />
            {copy('more')}
          </button>
          <div id="research-more" hidden={!more} className={more ? 'mt-3 grid gap-3 sm:grid-cols-2' : 'hidden'}>
            <Field id="research-signals" label={copy('signals')} help={copy('lineHelp')} error={errorAt('signals')}>
              <Textarea id="research-signals" rows={3} value={draft.signals} aria-invalid={!!errorAt('signals')} onChange={(e) => set('signals', e.target.value)} />
            </Field>
            <Field id="research-exclusions" label={copy('exclusions')} help={copy('lineHelp')} error={errorAt('exclusions')}>
              <Textarea id="research-exclusions" rows={3} value={draft.exclusions} aria-invalid={!!errorAt('exclusions')} onChange={(e) => set('exclusions', e.target.value)} />
            </Field>
            <Field id="research-segment" label={copy('segment')} error={errorAt('segment_key')}>
              <select id="research-segment" className={selectClass} value={draft.segment} aria-invalid={!!errorAt('segment_key')} onChange={(e) => set('segment', e.target.value)}>
                <option value="">{copy('segmentNone')}</option>
                {segmentOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select>
            </Field>
            <Field id="research-size" label={copy('size')} error={errorAt('size_hint')}>
              <Input id="research-size" autoComplete="off" placeholder={copy('sizeHint')} value={draft.size} aria-invalid={!!errorAt('size_hint')} onChange={(e) => set('size', e.target.value)} />
            </Field>
            <Field id="research-language" label={copy('language')} error={errorAt('language')}>
              <div className="flex min-w-0 gap-2">
                <select id="research-language" className={cn(selectClass, 'min-w-0 flex-1')} value={draft.language} aria-invalid={!!errorAt('language')} onChange={(e) => set('language', e.target.value)}>
                  <option value="">{copy('languageAny')}</option>
                  {LANGUAGES.map((tag) => <option key={tag} value={tag}>{languageName(tag, copy.language)}</option>)}
                  <option value={OTHER}>{copy('languageOther')}</option>
                </select>
                {draft.language === OTHER && (
                  <Input aria-label={copy('languageCode')} className="w-24" autoComplete="off" placeholder={copy('languageCodeHint')} value={draft.code} onChange={(e) => set('code', e.target.value)} />
                )}
              </div>
            </Field>
            <Field id="research-note" label={copy('note')} error={errorAt('note')}>
              <Textarea id="research-note" rows={3} value={draft.note} aria-invalid={!!errorAt('note')} onChange={(e) => set('note', e.target.value)} />
            </Field>
          </div>
        </div>
        {create.error && !refused ? <ErrorCallout error={create.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!valid} loading={create.isPending}>{copy('submit')}</Button>
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={() => onDone()}>{copy('back')}</Button>
        </div>
      </form>
    </div>
  );
}
