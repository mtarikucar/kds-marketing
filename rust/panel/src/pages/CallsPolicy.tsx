import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getCallPolicy, setCallPolicy, type CallPolicy } from '@/api/calls';
import { QueryState } from '@/components/QueryState';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Switch, Label, Textarea, toast } from '@/components/ui';
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

function PolicyForm({ stored }: { stored: CallPolicy }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<CallPolicy>(stored);
  const [holding, setHolding] = useState(stored.holding_default.join('\n'));
  useEffect(() => {
    setPolicy(stored);
    setHolding(stored.holding_default.join('\n'));
  }, [stored]);
  const save = useMutation({
    mutationFn: () =>
      setCallPolicy({
        ...policy,
        holding_default: holding
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        handoff_extension: policy.handoff_extension?.trim() ? policy.handoff_extension.trim() : null,
      }),
    onSuccess: async (saved) => {
      toast.success(t('calls.policy.saved'));
      queryClient.setQueryData(POLICY_KEY, saved);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate aria-label={t('calls.policy.title')}>
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
      <div className="flex items-center gap-3">
        <Switch
          id="calls-disclose"
          checked={policy.disclose_assistant}
          onCheckedChange={(on) => setPolicy({ ...policy, disclose_assistant: on })}
        />
        <Label htmlFor="calls-disclose" className="font-normal">
          {t('calls.policy.fields.disclose_assistant')}
        </Label>
      </div>
      <Field label={t('calls.policy.fields.holding_default')} hint={t('calls.policy.holdingHint')}>
        {(ids) => (
          <Textarea id={ids.id} aria-describedby={ids.describedBy} value={holding} onChange={(e) => setHolding(e.target.value)} />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
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
      </div>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** The call policy editor (calls.manage): sentences, timers, limits and the tariff estimate. */
export function CallsPolicy() {
  const { t } = useTranslation();
  const policy = useQuery({ queryKey: POLICY_KEY, queryFn: getCallPolicy });
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t('calls.policy.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryState query={policy}>{policy.data && <PolicyForm stored={policy.data} />}</QueryState>
      </CardContent>
    </Card>
  );
}
