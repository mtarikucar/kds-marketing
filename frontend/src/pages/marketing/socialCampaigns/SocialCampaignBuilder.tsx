import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Stepper, type StepperStep } from '@/components/ui/Stepper';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/RadioGroup';
import { Label } from '@/components/ui/Label';
import { Checkbox } from '@/components/ui/Checkbox';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { NETWORK_META } from '../social/networks';
import type { SocialAccount } from '../social/types';
import {
  createSocialCampaign,
  type SocialCampaignPayload,
  type SocialCampaignAutomationMode,
  type SocialCampaignPlanningMode,
} from '../../../features/marketing/api/socialCampaigns.service';

interface BuilderState {
  name: string;
  goal: string;
  theme: string;
  audience: string;
  perWeek: number;
  targetAccountIds: string[];
  mediaKinds: string[];
  automationMode: SocialCampaignAutomationMode;
  planningMode: SocialCampaignPlanningMode;
}

const INITIAL: BuilderState = {
  name: '',
  goal: '',
  theme: '',
  audience: '',
  perWeek: 3,
  targetAccountIds: [],
  mediaKinds: ['IMAGE'],
  automationMode: 'APPROVAL',
  planningMode: 'AI_PROPOSE',
};

export default function SocialCampaignBuilder() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [s, setS] = useState<BuilderState>(INITIAL);
  const set = <K extends keyof BuilderState>(k: K, v: BuilderState[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  // Reuse the Social Planner's connected-accounts query (same key/endpoint) so the
  // builder can offer the workspace's real destinations, not an empty list.
  const { data: accountsData, isLoading: accountsLoading } = useQuery({
    queryKey: ['marketing', 'social', 'accounts'],
    queryFn: () =>
      marketingApi.get('/social-planner/accounts').then((r) => r.data as SocialAccount[]),
  });
  const accounts: SocialAccount[] = Array.isArray(accountsData) ? accountsData : [];

  const toggleAccount = (id: string, on: boolean) =>
    set(
      'targetAccountIds',
      on ? [...s.targetAccountIds, id] : s.targetAccountIds.filter((x) => x !== id),
    );

  const steps: StepperStep[] = [
    { id: 'goal', label: t('socialCampaign.step.goal', 'Goal & theme') },
    { id: 'brief', label: t('socialCampaign.step.brief', 'Brief & Brand Kit') },
    { id: 'channels', label: t('socialCampaign.step.channels', 'Channels & cadence') },
    { id: 'automation', label: t('socialCampaign.step.automation', 'Automation mode') },
    { id: 'planning', label: t('socialCampaign.step.planning', 'Planning mode') },
    { id: 'review', label: t('socialCampaign.step.review', 'Review') },
  ];

  const create = useMutation({
    mutationFn: () => {
      const payload: SocialCampaignPayload = {
        name: s.name.trim(),
        goal: s.goal || undefined,
        theme: s.theme || undefined,
        brief: { audience: s.audience || undefined },
        automationMode: s.automationMode,
        planningMode: s.planningMode,
        cadence: {
          perWeek: s.perWeek,
          daysOfWeek: [1, 3, 5],
          timeOfDay: '09:00',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        startDate: new Date().toISOString(),
        targetAccountIds: s.targetAccountIds,
        mediaKinds: s.mediaKinds,
      };
      return createSocialCampaign(payload);
    },
    onSuccess: (sc) => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'social-campaigns'] });
      toast.success(t('socialCampaign.created', 'Campaign created'));
      navigate(`/social-campaigns/${sc.id}`);
    },
    onError: () => toast.error(t('socialCampaign.createFailed', 'Could not create campaign')),
  });

  // Automated modes must have somewhere to publish; APPROVAL can attach targets later.
  const accountsMissing = s.automationMode !== 'APPROVAL' && s.targetAccountIds.length === 0;
  // Gate Next on the name (step 0) and on target accounts once the mode is picked (step 3).
  const canAdvance = (step !== 0 || s.name.trim().length > 0) && (step !== 3 || !accountsMissing);
  const isLast = step === steps.length - 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('socialCampaign.newTitle', 'New social campaign')}
        description={t('socialCampaign.newSubtitle', 'AI plans and progresses your content.')}
      />
      <Stepper
        steps={steps}
        current={step}
        aria-label={t('socialCampaign.stepsLabel', 'Campaign builder steps')}
        onStepClick={setStep}
      />

      <div className="max-w-xl space-y-4">
        {step === 0 && (
          <>
            <Field label={t('socialCampaign.f.name', 'Name')}>
              {({ id }) => (
                <Input id={id} value={s.name} onChange={(e) => set('name', e.target.value)} />
              )}
            </Field>
            <Field label={t('socialCampaign.f.goal', 'Goal')}>
              {({ id }) => (
                <Input id={id} value={s.goal} onChange={(e) => set('goal', e.target.value)} />
              )}
            </Field>
            <Field label={t('socialCampaign.f.theme', 'Theme')}>
              {({ id }) => (
                <Input id={id} value={s.theme} onChange={(e) => set('theme', e.target.value)} />
              )}
            </Field>
          </>
        )}

        {step === 1 && (
          <Field label={t('socialCampaign.f.audience', 'Audience')}>
            {({ id }) => (
              <Textarea id={id} value={s.audience} onChange={(e) => set('audience', e.target.value)} />
            )}
          </Field>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <Field label={t('socialCampaign.f.perWeek', 'Posts per week')}>
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={s.perWeek}
                  onChange={(e) => set('perWeek', Number(e.target.value) || 1)}
                />
              )}
            </Field>

            <div className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t('socialCampaign.f.accounts', 'Target accounts')}
              </span>
              {accountsLoading ? (
                <p className="text-caption text-muted-foreground">
                  {t('socialCampaign.accounts.loading', 'Loading connected accounts…')}
                </p>
              ) : accounts.length === 0 ? (
                <p className="text-caption text-muted-foreground">
                  {t('socialCampaign.accounts.empty', 'No connected accounts yet. ')}
                  <Link to="/social" className="text-primary underline">
                    {t('socialCampaign.accounts.connect', 'Connect one in the Social Planner')}
                  </Link>
                  {t('socialCampaign.accounts.emptyAfter', ' so this campaign has somewhere to publish.')}
                </p>
              ) : (
                <div className="grid gap-1.5 rounded-lg border border-border p-2 sm:grid-cols-2">
                  {accounts.map((acc) => {
                    const meta = NETWORK_META[acc.network];
                    const Icon = meta.icon;
                    const checked = s.targetAccountIds.includes(acc.id);
                    return (
                      <label
                        key={acc.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-muted"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={!acc.enabled}
                          onCheckedChange={(v) => toggleAccount(acc.id, v === true)}
                        />
                        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span className="truncate text-sm text-foreground">{acc.displayName}</span>
                        <span className="ms-auto text-micro text-muted-foreground">{meta.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-caption text-muted-foreground">
                {t(
                  'socialCampaign.accounts.hint',
                  'Automated publishing (Semi-auto / Full-auto) needs at least one target account.',
                )}
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <RadioGroup
              value={s.automationMode}
              onValueChange={(v) => set('automationMode', v as SocialCampaignAutomationMode)}
            >
              {(['APPROVAL', 'SEMI_AUTO', 'FULL_AUTO'] as const).map((m) => (
                <div key={m} className="flex items-center gap-2">
                  <RadioGroupItem value={m} id={`auto-${m}`} />
                  <Label htmlFor={`auto-${m}`}>{m}</Label>
                </div>
              ))}
            </RadioGroup>
            {accountsMissing && (
              <p className="text-caption text-danger" role="alert">
                {t(
                  'socialCampaign.accounts.required',
                  'Automated publishing needs at least one target account — go back to “Channels & cadence” to pick one, or choose Approval.',
                )}
              </p>
            )}
          </div>
        )}

        {step === 4 && (
          <RadioGroup
            value={s.planningMode}
            onValueChange={(v) => set('planningMode', v as SocialCampaignPlanningMode)}
          >
            {(['AI_PROPOSE', 'AI_FULL', 'USER_TOPICS'] as const).map((m) => (
              <div key={m} className="flex items-center gap-2">
                <RadioGroupItem value={m} id={`plan-${m}`} />
                <Label htmlFor={`plan-${m}`}>{m}</Label>
              </div>
            ))}
          </RadioGroup>
        )}

        {step === 5 && (
          <>
            <dl className="space-y-1 text-sm">
              <div><dt className="inline font-medium">{t('socialCampaign.f.name', 'Name')}: </dt><dd className="inline">{s.name}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.automation', 'Automation')}: </dt><dd className="inline">{s.automationMode}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.planning', 'Planning')}: </dt><dd className="inline">{s.planningMode}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.perWeek', 'Posts per week')}: </dt><dd className="inline">{s.perWeek}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.accounts', 'Target accounts')}: </dt><dd className="inline">{s.targetAccountIds.length}</dd></div>
            </dl>
            {accountsMissing && (
              <p className="mt-2 text-caption text-danger" role="alert">
                {t(
                  'socialCampaign.accounts.required',
                  'Automated publishing needs at least one target account — go back to “Channels & cadence” to pick one, or choose Approval.',
                )}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex gap-2">
        {step > 0 && (
          <Button variant="secondary" onClick={() => setStep((n) => n - 1)}>
            {t('common.back', 'Back')}
          </Button>
        )}
        {isLast ? (
          <Button loading={create.isPending} disabled={accountsMissing} onClick={() => create.mutate()}>
            {t('socialCampaign.create', 'Create campaign')}
          </Button>
        ) : (
          <Button disabled={!canAdvance} onClick={() => setStep((n) => n + 1)}>
            {t('common.next', 'Next')}
          </Button>
        )}
      </div>
    </div>
  );
}
