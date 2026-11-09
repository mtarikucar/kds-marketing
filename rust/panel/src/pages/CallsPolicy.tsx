import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare,
  Bell,
  Clock3,
  Ear,
  PhoneOff,
  SlidersHorizontal,
  Plus,
  X,
  ChevronDown,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCallPolicy, setCallPolicy, type CallPolicy } from '@/api/calls';
import { QueryState } from '@/components/QueryState';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Field, Input, Switch, Label, Textarea, cn, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import {
  SECTIONS,
  NUMBERS,
  FIELD_SECTION,
  numberTexts,
  phraseList,
  payload,
  validate,
  type Section,
  type NumberKey,
  type TextKey,
  type PhraseKey,
} from './calls/policyModel';

const POLICY_KEY = ['calls', 'policy'] as const;
const icons = {
  opening: MessageSquare,
  notices: Bell,
  waiting: Clock3,
  silence: Ear,
  ending: PhoneOff,
  limits: SlidersHorizontal,
};
const selectClass = 'h-11 w-full min-w-0 rounded-md border border-input bg-surface px-3 text-sm';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function PolicyForm({ stored }: { stored: CallPolicy }) {
  const { t } = useTranslation();
  const copy = (key: string, values = {}) =>
    t(`calls.policy.editor.${key}`, { defaultValue: key, ...values });
  const client = useQueryClient();
  const [baseline, setBaseline] = useState(stored);
  const [policy, setPolicy] = useState(stored);
  const [numbers, setNumbers] = useState(numberTexts(stored));
  const [section, setSection] = useState<Section>('opening');
  const [direction, setDirection] = useState<TextKey>('greeting_inbound');
  const [waitingPhrase, setWaitingPhrase] = useState<PhraseKey>('holding_default');
  const [silencePhrase, setSilencePhrase] = useState<PhraseKey>('not_heard');
  const [ending, setEnding] = useState<'closing' | 'voicemail_text' | 'fault'>('closing');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty = !same(policy, baseline) || !same(numbers, numberTexts(baseline));
  const conflict = dirty && !same(stored, baseline);
  const reset = (next: CallPolicy) => {
    setPolicy(next);
    setBaseline(next);
    setNumbers(numberTexts(next));
    setNeedsReload(false);
  };
  // A focus/background refresh must not replace a user's unfinished sentence.
  useEffect(() => {
    if (!dirty && !same(stored, baseline) && same(stored, client.getQueryData(POLICY_KEY))) reset(stored);
  }, [stored, baseline, dirty, client]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = useMutation({
    mutationFn: () => setCallPolicy(payload(policy, numbers)),
    onSuccess: async () => {
      // GET resolves workspace templates; PUT's raw nulls must not become empty input values.
      try {
        reset(await client.fetchQuery({ queryKey: POLICY_KEY, queryFn: getCallPolicy, staleTime: 0 }));
        toast.success(t('calls.policy.saved'));
      } catch {
        setNeedsReload(true);
        toast.error(copy('savedReadFailed'));
      }
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const reload = async () => {
    setReloading(true);
    try {
      reset(await client.fetchQuery({ queryKey: POLICY_KEY, queryFn: getCallPolicy, staleTime: 0 }));
    } catch (err) {
      toast.error(errorMessage(t, err));
    } finally {
      setReloading(false);
    }
  };
  const issues = validate(policy, numbers);
  const changed = SECTIONS.filter((s) => {
    const keys = Object.keys(FIELD_SECTION) as (keyof typeof FIELD_SECTION)[];
    return keys.some(
      (k) =>
        FIELD_SECTION[k] === s &&
        (NUMBERS.includes(k as NumberKey)
          ? numbers[k as NumberKey] !== String(baseline[k as NumberKey])
          : k in policy
            ? !same(policy[k as keyof CallPolicy], baseline[k as keyof CallPolicy])
            : !same(phraseList(policy, k as PhraseKey), phraseList(baseline, k as PhraseKey))),
    );
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (issues.length) {
      setSection(issues[0].section);
      return;
    }
    if (dirty && !save.isPending && !conflict && !needsReload) save.mutate();
  };
  const textField = (key: TextKey, hint?: string) => (
    <Field label={t(`calls.policy.fields.${key}`)} hint={hint}>
      {(ids) => (
        <Textarea
          id={ids.id}
          aria-describedby={ids.describedBy}
          value={policy[key] ?? ''}
          maxLength={600}
          rows={3}
          onChange={(e) => setPolicy({ ...policy, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  const numberField = (key: NumberKey, max?: number) => (
    <Field label={t(`calls.policy.fields.${key}`)}>
      {(ids) => (
        <Input
          id={ids.id}
          type="number"
          step={1}
          min={key === 'estimated_minor_per_minute' ? 0 : 1}
          max={max}
          value={numbers[key]}
          onChange={(e) => setNumbers({ ...numbers, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  const phraseLabel = (key: PhraseKey) =>
    t(key === 'holding_default' ? 'calls.policy.fields.holding_default' : `calls.policy.phrases.${key}`);
  const phraseEditor = (key: PhraseKey) => {
    const list = phraseList(policy, key);
    const update = (next: string[]) =>
      setPolicy(
        key === 'holding_default'
          ? { ...policy, holding_default: next }
          : { ...policy, phrases: { ...policy.phrases, [key]: next } },
      );
    return (
      <div className="space-y-3">
        <p className="text-caption text-muted-foreground">{copy('phraseHelp', { count: list.length })}</p>
        {list.map((line, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Field label={copy('phraseLabel', { number: index + 1 })}>
                {(ids) => (
                  <Textarea
                    id={ids.id}
                    value={line}
                    rows={2}
                    maxLength={600}
                    onChange={(e) => update(list.map((s, i) => (i === index ? e.target.value : s)))}
                  />
                )}
              </Field>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="mt-7 shrink-0"
              aria-label={copy('removePhrase', { number: index + 1 })}
              onClick={() => update(list.filter((_, i) => i !== index))}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={list.length >= 5}
          onClick={() => update([...list, ''])}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {copy('addPhrase')}
        </Button>
      </div>
    );
  };
  const phraseSelector = (value: PhraseKey, options: PhraseKey[], onChange: (key: PhraseKey) => void) => (
    <Field label={copy('phraseType')}>
      {(ids) => (
        <select
          id={ids.id}
          className={selectClass}
          value={value}
          onChange={(e) => onChange(e.target.value as PhraseKey)}
        >
          {options.map((k) => (
            <option key={k} value={k}>
              {phraseLabel(k)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  const quote = (value: string | null | undefined) => (
    <p className="whitespace-pre-wrap break-words text-sm leading-6">
      {value === null ? copy('template') : value?.trim() || copy('noText')}
    </p>
  );
  const preview = () => {
    if (section === 'opening')
      return (
        <>
          <p className="text-caption text-muted-foreground">{t(`calls.policy.fields.${direction}`)}</p>
          {quote(policy[direction])}
          <p className="text-caption text-muted-foreground">{copy('openingPreviewHint')}</p>
        </>
      );
    if (section === 'notices')
      return (
        <>
          {quote(policy.transcript_notice)}
          <p className="text-caption text-muted-foreground">
            {policy.disclose_assistant ? copy('disclosureOn') : copy('disclosureOff')}
          </p>
          {policy.disclose_assistant && quote(policy.disclosure_sentence)}
          <p className="text-caption text-muted-foreground">{copy('recordingHint')}</p>
        </>
      );
    if (section === 'waiting' || section === 'silence') {
      const steps =
        section === 'waiting'
          ? [
              ['slow_agent_s', 'firstWait'],
              ['holding_again_s', 'secondWait'],
              ['fallback_after_s', 'fallback'],
            ]
          : [
              ['caller_silence_s', 'notifyAgent'],
              ['caller_silence_close_s', 'endSilence'],
            ];
      return (
        <>
          <ol className="space-y-4 border-s border-border ps-4">
            {steps.map(([key, label]) => (
              <li key={key}>
                <span className="text-sm font-medium tabular-nums">
                  {copy('seconds', { value: numbers[key as NumberKey] || '—' })}
                </span>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{copy(label)}</p>
              </li>
            ))}
          </ol>
          <p className="text-caption text-muted-foreground">
            {copy(section === 'waiting' ? 'waitingPreviewHint' : 'silencePreviewHint')}
          </p>
        </>
      );
    }
    if (section === 'ending')
      return (
        <>
          {quote(ending === 'fault' ? policy.phrases.fault.find((s) => s.trim()) : policy[ending])}
          <p className="text-caption text-muted-foreground">
            {ending === 'closing' ? t('calls.policy.closingHint') : copy('variantPreview')}
          </p>
        </>
      );
    return (
      <>
        <p className="text-2xl tabular-nums">{copy('seconds', { value: numbers.max_duration_s || '—' })}</p>
        <p className="text-sm text-muted-foreground">{copy('durationHint')}</p>
        <p className="text-sm">
          {policy.handoff_extension?.trim()
            ? copy('extensionPreview', { value: policy.handoff_extension })
            : copy('noExtension')}
        </p>
        <p className="text-caption text-muted-foreground">{copy('priceHint')}</p>
      </>
    );
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('calls.policy.title')} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{copy('intro')}</p>
        <p role="status" className="text-caption text-muted-foreground">
          {dirty ? copy('changed', { count: changed.length }) : copy('upToDate')}
        </p>
      </div>
      {(conflict || needsReload) && (
        <p role="alert" className="border-s-2 border-warning ps-3 text-sm leading-6">
          {copy(needsReload ? 'savedReadFailed' : 'conflict')}
        </p>
      )}
      {issues.length > 0 && (
        <div role="alert" className="space-y-2 border-s-2 border-danger ps-3 text-sm">
          <p>{copy('fixBeforeSave')}</p>
          {issues.map((issue) => (
            <button
              key={issue.section + issue.key}
              type="button"
              className="block text-start text-danger underline"
              onClick={() => setSection(issue.section)}
            >
              {copy(`sections.${issue.section}.title`)}: {copy(issue.key)}
            </button>
          ))}
        </div>
      )}
      <div className="grid min-w-0 items-start gap-6 md:grid-cols-[176px_minmax(0,1fr)] xl:grid-cols-[176px_minmax(0,1fr)_240px]">
        <nav aria-label={copy('navigation')}>
          <label className="block text-sm md:hidden">
            {copy('navigation')}
            <select
              className={cn(selectClass, 'mt-2')}
              value={section}
              onChange={(e) => setSection(e.target.value as Section)}
            >
              {SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {copy(`sections.${s}.title`)}
                  {changed.includes(s) ? ' *' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="hidden space-y-1 md:block">
            {SECTIONS.map((s) => {
              const Icon = icons[s];
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={section === s}
                  onClick={() => setSection(s)}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    section === s
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-surface-muted',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{copy(`sections.${s}.title`)}</span>
                  {changed.includes(s) && <span aria-label={copy('modified')}>•</span>}
                </button>
              );
            })}
          </div>
        </nav>
        <section
          className="min-w-0 border-t-2 border-foreground bg-surface p-4 sm:p-6"
          aria-labelledby="call-scenario-title"
        >
          <h2 id="call-scenario-title" className="text-lg font-medium">
            {copy(`sections.${section}.title`)}
          </h2>
          <p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">
            {copy(`sections.${section}.help`)}
          </p>
          <fieldset disabled={save.isPending || reloading || needsReload} className="min-w-0 space-y-5">
            {section === 'opening' && (
              <>
                <Field label={copy('direction')}>
                  {(ids) => (
                    <select
                      id={ids.id}
                      className={selectClass}
                      value={direction}
                      onChange={(e) => setDirection(e.target.value as TextKey)}
                    >
                      <option value="greeting_inbound">{copy('inbound')}</option>
                      <option value="opening_outbound">{copy('outbound')}</option>
                    </select>
                  )}
                </Field>
                {textField(direction, copy('emptyOpening'))}
              </>
            )}
            {section === 'notices' && (
              <>
                <div className="flex items-start gap-3">
                  <Switch
                    id="calls-disclose"
                    checked={policy.disclose_assistant}
                    onCheckedChange={(on) => setPolicy({ ...policy, disclose_assistant: on })}
                  />
                  <Label htmlFor="calls-disclose" className="font-normal leading-6">
                    {t('calls.policy.fields.disclose_assistant')}
                  </Label>
                </div>
                {textField('disclosure_sentence', copy('disclosureHint'))}
                {policy.disclose_assistant && !policy.disclosure_sentence.trim() && (
                  <p className="text-sm text-warning">{copy('missingDisclosure')}</p>
                )}
                {textField('transcript_notice', copy('transcriptHint'))}
                {textField('recording_announcement', copy('recordingHint'))}
              </>
            )}
            {section === 'waiting' && (
              <>
                <div className="grid items-end gap-3 sm:grid-cols-3">
                  {numberField('slow_agent_s', 58)}
                  {numberField('holding_again_s', 59)}
                  {numberField('fallback_after_s', 60)}
                </div>
                {phraseSelector(
                  waitingPhrase,
                  ['holding_default', 'acknowledgements', 'fillers', 'long_wait'],
                  setWaitingPhrase,
                )}
                {phraseEditor(waitingPhrase)}
              </>
            )}
            {section === 'silence' && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {numberField('caller_silence_s', 119)}
                  {numberField('caller_silence_close_s', 120)}
                </div>
                {phraseSelector(silencePhrase, ['not_heard', 'still_there'], setSilencePhrase)}
                {phraseEditor(silencePhrase)}
              </>
            )}
            {section === 'ending' && (
              <>
                <Field label={copy('situation')}>
                  {(ids) => (
                    <select
                      id={ids.id}
                      className={selectClass}
                      value={ending}
                      onChange={(e) => setEnding(e.target.value as typeof ending)}
                    >
                      {(['closing', 'voicemail_text', 'fault'] as const).map((k) => (
                        <option key={k} value={k}>
                          {copy(`endings.${k}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {ending === 'fault'
                  ? phraseEditor('fault')
                  : textField(ending, ending === 'closing' ? t('calls.policy.closingHint') : undefined)}
              </>
            )}
            {section === 'limits' && (
              <>
                {numberField('max_duration_s', 900)}
                <Field label={t('calls.policy.fields.handoff_extension')} hint={copy('extensionHint')}>
                  {(ids) => (
                    <Input
                      id={ids.id}
                      aria-describedby={ids.describedBy}
                      inputMode="numeric"
                      maxLength={16}
                      value={policy.handoff_extension ?? ''}
                      onChange={(e) => setPolicy({ ...policy, handoff_extension: e.target.value })}
                    />
                  )}
                </Field>
                {numberField('estimated_minor_per_minute')}
              </>
            )}
          </fieldset>
        </section>
        <aside
          className="min-w-0 border-t border-border pt-4 md:col-start-2 xl:col-start-3"
          aria-label={copy('preview')}
        >
          <h3 className="hidden text-sm font-medium xl:block">{copy('preview')}</h3>
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between text-sm font-medium xl:hidden"
            aria-expanded={previewOpen}
            aria-controls="call-policy-preview"
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            {copy('preview')}
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </button>
          <div
            id="call-policy-preview"
            className={cn('mt-4 space-y-4', previewOpen ? 'block' : 'hidden xl:block')}
          >
            {preview()}
            <p className="border-t border-border pt-3 text-caption text-muted-foreground">
              {copy('previewHint')}
            </p>
          </div>
        </aside>
      </div>
      <ErrorCallout error={save.error} />
      <div className="xl:sticky xl:bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-4">
        <p className="text-caption text-muted-foreground">{copy('saveHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={(!dirty && !needsReload) || save.isPending || reloading}
            onClick={() => (needsReload ? void reload() : reset(stored))}
          >
            {copy(needsReload || conflict ? 'loadLatest' : 'discard')}
          </Button>
          <Button
            type="submit"
            disabled={!dirty || conflict || needsReload || reloading}
            loading={save.isPending}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function CallsPolicy() {
  const policy = useQuery({ queryKey: POLICY_KEY, queryFn: getCallPolicy });
  return (
    <div className="pt-5">
      <QueryState query={policy} keepOnError>
        {policy.data && <PolicyForm stored={policy.data} />}
      </QueryState>
    </div>
  );
}
