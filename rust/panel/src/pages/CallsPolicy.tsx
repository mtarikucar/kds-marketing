import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getCallPolicy, setCallPolicy, type CallPhrases, type CallPolicy } from '@/api/calls';
import { QueryState } from '@/components/QueryState';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Switch, Label, Textarea, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';

const POLICY_KEY = ['calls', 'policy'] as const;

type TextKey = 'greeting_inbound' | 'voicemail_text' | 'recording_announcement' | 'disclosure_sentence';
const TEXTS: TextKey[] = ['greeting_inbound', 'voicemail_text', 'recording_announcement', 'disclosure_sentence'];
type NumberKey =
  | 'max_duration_s'
  | 'slow_agent_s'
  | 'holding_again_s'
  | 'fallback_after_s'
  | 'caller_silence_s'
  | 'caller_silence_close_s'
  | 'estimated_minor_per_minute';
const NUMBERS: NumberKey[] = [
  'max_duration_s',
  'slow_agent_s',
  'holding_again_s',
  'fallback_after_s',
  'caller_silence_s',
  'caller_silence_close_s',
  'estimated_minor_per_minute',
];
type OpeningKey = 'opening_outbound' | 'transcript_notice' | 'closing';
const OPENINGS: OpeningKey[] = ['opening_outbound', 'transcript_notice', 'closing'];
type PhraseKey = keyof CallPhrases;
const PHRASE_SETS: PhraseKey[] = ['acknowledgements', 'fillers', 'long_wait', 'not_heard', 'still_there', 'fault'];
/** One sentence per non-empty line, trimmed. */
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const joined = (p: CallPhrases) =>
  Object.fromEntries(PHRASE_SETS.map((k) => [k, p[k].join('\n')])) as Record<PhraseKey, string>;
/** The six lists of phrases from their textareas, one sentence per line. */
const split = (texts: Record<PhraseKey, string>): CallPhrases => {
  const phrases = {} as CallPhrases;
  for (const k of PHRASE_SETS) phrases[k] = lines(texts[k]);
  return phrases;
};

function PolicyForm({ stored }: { stored: CallPolicy }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<CallPolicy>(stored);
  const [holding, setHolding] = useState(stored.holding_default.join('\n'));
  const [phrases, setPhrases] = useState(joined(stored.phrases));
  useEffect(() => {
    setPolicy(stored);
    setHolding(stored.holding_default.join('\n'));
    setPhrases(joined(stored.phrases));
  }, [stored]);
  const save = useMutation({
    mutationFn: () =>
      setCallPolicy({
        ...policy,
        holding_default: lines(holding),
        phrases: split(phrases),
        handoff_extension: policy.handoff_extension?.trim() ? policy.handoff_extension.trim() : null,
      }),
    onSuccess: async () => {
      toast.success(t('calls.policy.saved'));
      // Read again: the save answers the stored policy, where a template the owner left unwritten
      // is null or empty; the read shows it with the workspace's name, as the calls play it, and a
      // text saved exactly as shown keeps following that name.
      await queryClient.invalidateQueries({ queryKey: POLICY_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <form className="flex flex-col gap-7" onSubmit={submit} noValidate aria-label={t('calls.policy.title')}>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('calls.policy.ux.sectionHint', { defaultValue: 'Değiştirmek istediğiniz bölümü açın. Kapalı bölümlerdeki değerler ve taslak düzenlemeler korunur; Kaydet tüm ayarları birlikte uygular.' })}</p>
      <details open>
      <summary className="cursor-pointer text-base font-medium">{t('calls.policy.scriptsTitle')}</summary>
      <fieldset className="grid min-w-0 gap-5 pt-5 md:grid-cols-2">
      <legend className="sr-only">{t('calls.policy.scriptsTitle')}</legend>
      {TEXTS.map((key) => (
        <Field key={key} label={t(`calls.policy.fields.${key}`)}>
          {(ids) => (
            <Textarea
              id={ids.id}
              value={policy[key]}
              maxLength={600}
              onChange={(e) => setPolicy({ ...policy, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
      {OPENINGS.map((key) => (
        <Field
          key={key}
          label={t(`calls.policy.fields.${key}`)}
          hint={t(key === 'closing' ? 'calls.policy.closingHint' : 'calls.policy.openingHint')}
        >
          {(ids) => (
            <Textarea
              id={ids.id}
              aria-describedby={ids.describedBy}
              value={policy[key] ?? ''}
              maxLength={600}
              onChange={(e) => setPolicy({ ...policy, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-muted p-4 md:col-span-2">
        <Switch
          id="calls-disclose"
          checked={policy.disclose_assistant}
          onCheckedChange={(on) => setPolicy({ ...policy, disclose_assistant: on })}
        />
        <Label htmlFor="calls-disclose" className="font-normal leading-6">
          {t('calls.policy.fields.disclose_assistant')}
        </Label>
      </div>
      </fieldset>
      </details>
      <details className="border-t border-border pt-4">
      <summary className="cursor-pointer text-base font-medium">{t('calls.policy.phrasesTitle')}</summary>
      <fieldset className="grid min-w-0 gap-5 pt-5 md:grid-cols-2">
      <legend className="sr-only">{t('calls.policy.phrasesTitle')}</legend>
      <Field label={t('calls.policy.fields.holding_default')} hint={t('calls.policy.holdingHint')}>
        {(ids) => (
          <Textarea id={ids.id} aria-describedby={ids.describedBy} value={holding} onChange={(e) => setHolding(e.target.value)} />
        )}
      </Field>
      {PHRASE_SETS.map((key) => (
        <Field key={key} label={t(`calls.policy.phrases.${key}`)} hint={t('calls.policy.phrasesHint')}>
          {(ids) => (
            <Textarea
              id={ids.id}
              aria-describedby={ids.describedBy}
              value={phrases[key]}
              onChange={(e) => setPhrases({ ...phrases, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
      </fieldset>
      </details>
      <details className="border-t border-border pt-4">
      <summary className="cursor-pointer text-base font-medium">{t('calls.policy.limitsTitle')}</summary>
      <fieldset className="grid min-w-0 gap-5 pt-5 sm:grid-cols-2 xl:grid-cols-3">
        <legend className="sr-only">{t('calls.policy.limitsTitle')}</legend>
        {NUMBERS.map((key) => (
          <Field key={key} label={t(`calls.policy.fields.${key}`)}>
            {(ids) => (
              <Input
                id={ids.id}
                type="number"
                min={0}
                value={String(policy[key])}
                onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
              />
            )}
          </Field>
        ))}
        <Field label={t('calls.policy.fields.handoff_extension')}>
          {(ids) => (
            <Input
              id={ids.id}
              inputMode="numeric"
              value={policy.handoff_extension ?? ''}
              onChange={(e) => setPolicy({ ...policy, handoff_extension: e.target.value })}
            />
          )}
        </Field>
      </fieldset>
      </details>
      <ErrorCallout error={save.error} />
      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The call policy editor (calls.manage): sentences (an agent call's opening, notice and closing, and
 * the phrases the voice bridge plays on its own), timers, limits and the tariff estimate.
 */
export function CallsPolicy() {
  const { t } = useTranslation();
  const policy = useQuery({ queryKey: POLICY_KEY, queryFn: getCallPolicy });
  return (
    <Card className="mt-12 rounded-none border-x-0 border-b-0 bg-transparent">
      <CardHeader className="mb-6 border-b border-border px-0 py-5">
        <CardTitle>{t('calls.policy.title')}</CardTitle>
        <CardDescription className="max-w-2xl leading-6">{t('calls.policy.description')}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <QueryState query={policy}>{policy.data && <PolicyForm stored={policy.data} />}</QueryState>
      </CardContent>
    </Card>
  );
}
