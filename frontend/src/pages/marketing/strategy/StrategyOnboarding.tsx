import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, CheckCircle2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Input,
  Textarea,
  Button,
  Callout,
  Spinner,
} from '@/components/ui';
import {
  startIntake,
  answerIntake,
  finishIntake,
  type StartIntakePayload,
} from '../../../features/marketing/api/strategy.service';

type Step = 'intake' | 'analyzing' | 'qa' | 'finishing' | 'skipped' | 'done';

/**
 * Strategy onboarding wizard (Task 9) — a self-contained state-machine flow:
 *   intake form → adaptive Q&A loop → finish → console.
 * The URL is the only required input; socials + a one-liner are optional hints.
 * `{skipped}` (AI not configured server-side) is handled gracefully at both the
 * start and finish turns with a friendly message instead of an error.
 */
export default function StrategyOnboarding() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('intake');

  // intake form — only the three networks the backend auto-analysis supports.
  const [url, setUrl] = useState('');
  const [oneLiner, setOneLiner] = useState('');
  const [facebook, setFacebook] = useState('');
  const [instagram, setInstagram] = useState('');
  const [linkedin, setLinkedin] = useState('');

  // adaptive Q&A
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);

  const finishAt = (id: string) => finishIntake(id);

  const finish = useMutation({
    mutationFn: (id: string) => finishAt(id),
    onSuccess: (res) => {
      if ('skipped' in res && res.skipped) {
        setStep('skipped');
        return;
      }
      // Freshly created strategy — drop any cached null so the console refetches.
      queryClient.invalidateQueries({ queryKey: ['marketing', 'strategy'] });
      setStep('done');
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message ?? t('strategy.onboarding.finishFailed', 'Could not build your strategy. Please try again.'));
      setStep('qa');
    },
  });

  const answer = useMutation({
    mutationFn: (payload: { sessionId: string; answers: string[] }) =>
      answerIntake(payload.sessionId, payload.answers),
    onSuccess: (res) => {
      if ('done' in res && res.done) {
        // Intake gathered enough — synthesize the strategy.
        setStep('finishing');
        if (sessionId) finish.mutate(sessionId);
        return;
      }
      setQuestions(res.questions);
      setAnswers(res.questions.map(() => ''));
      setStep('qa');
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message ?? t('strategy.onboarding.answerFailed', 'Could not submit your answers. Please try again.'));
    },
  });

  const start = useMutation({
    mutationFn: (payload: StartIntakePayload) => startIntake(payload),
    onSuccess: (res) => {
      if ('skipped' in res && res.skipped) {
        setStep('skipped');
        return;
      }
      setSessionId(res.sessionId);
      setQuestions(res.questions);
      setAnswers(res.questions.map(() => ''));
      setStep('qa');
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message ?? t('strategy.onboarding.startFailed', 'Could not start the analysis. Please try again.'));
      setStep('intake');
    },
  });

  const submitIntake = () => {
    // Backend expects an array of { network, handle } (handle ≤200 chars), NOT
    // a keyed object — and only these three networks.
    const socials: NonNullable<StartIntakePayload['socials']> = [];
    if (instagram.trim()) socials.push({ network: 'INSTAGRAM', handle: instagram.trim().slice(0, 200) });
    if (facebook.trim()) socials.push({ network: 'FACEBOOK', handle: facebook.trim().slice(0, 200) });
    if (linkedin.trim()) socials.push({ network: 'LINKEDIN', handle: linkedin.trim().slice(0, 200) });
    setStep('analyzing');
    start.mutate({
      url: url.trim(),
      oneLiner: oneLiner.trim().slice(0, 500) || undefined,
      socials: socials.length ? socials : undefined,
    });
  };

  const submitAnswers = () => {
    if (!sessionId) return;
    answer.mutate({ sessionId, answers });
  };

  const updateAnswer = (i: number, v: string) =>
    setAnswers((a) => a.map((row, idx) => (idx === i ? v : row)));

  // ── intake form ────────────────────────────────────────────────────────────
  if (step === 'intake') {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.onboarding.title', 'Build your marketing strategy with AI')}</CardTitle>
            <CardDescription>
              {t(
                'strategy.onboarding.subtitle',
                'Point us at your website — we’ll analyze it, ask a few sharp questions, and draft a full strategy with an action plan.',
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label={t('strategy.onboarding.websiteUrl', 'Website URL')} hint={t('strategy.onboarding.websiteUrlHint', 'Required — this is our main source.')}>
              {({ id }) => (
                <Input
                  id={id}
                  placeholder="https://your-brand.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              )}
            </Field>

            <Field label={t('strategy.onboarding.oneLiner', 'One-liner (optional)')}>
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={2}
                  maxLength={500}
                  placeholder={t('strategy.onboarding.oneLinerPlaceholder', 'e.g. We help dental clinics fill their calendars with local patients.')}
                  value={oneLiner}
                  onChange={(e) => setOneLiner(e.target.value)}
                />
              )}
            </Field>

            <div className="space-y-3">
              <p className="text-sm font-medium text-foreground">{t('strategy.onboarding.socials', 'Social accounts (optional)')}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Instagram">
                  {({ id }) => <Input id={id} placeholder="@brand" value={instagram} onChange={(e) => setInstagram(e.target.value)} />}
                </Field>
                <Field label="Facebook">
                  {({ id }) => <Input id={id} placeholder="facebook.com/brand" value={facebook} onChange={(e) => setFacebook(e.target.value)} />}
                </Field>
                <Field label="LinkedIn">
                  {({ id }) => <Input id={id} placeholder="linkedin.com/company/brand" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />}
                </Field>
              </div>
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={() => navigate('/studio/strategy')}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={submitIntake} disabled={!url.trim()}>
              <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('strategy.onboarding.analyze', 'Analyze & continue')}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── auto-analysis / between-turn loading ──────────────────────────────────
  if (step === 'analyzing' || step === 'finishing') {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Spinner className="h-6 w-6 text-primary" />
            <p className="text-sm text-muted-foreground">
              {step === 'analyzing'
                ? t('strategy.onboarding.analyzing', 'Analyzing your website and channels…')
                : t('strategy.onboarding.building', 'Building your strategy and action plan…')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── adaptive Q&A ──────────────────────────────────────────────────────────
  if (step === 'qa') {
    const answering = answer.isPending;
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.onboarding.questionsTitle', 'A few questions')}</CardTitle>
            <CardDescription>
              {t('strategy.onboarding.questionsSubtitle', 'Your answers sharpen the strategy — be as specific as you like.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {questions.map((q, i) => (
              <Field key={i} label={q}>
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={2}
                    value={answers[i] ?? ''}
                    onChange={(e) => updateAnswer(i, e.target.value)}
                  />
                )}
              </Field>
            ))}
          </CardContent>
          <CardFooter className="justify-end border-t border-border pt-4">
            <Button onClick={submitAnswers} disabled={answering} loading={answering}>
              {t('strategy.onboarding.submitAnswers', 'Continue')}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── AI not configured ─────────────────────────────────────────────────────
  if (step === 'skipped') {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.onboarding.title', 'Build your marketing strategy with AI')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Callout tone="info" title={t('strategy.onboarding.skippedTitle', 'AI strategy isn’t available yet')}>
              {t(
                'strategy.onboarding.skippedDesc',
                'The AI strategist isn’t configured for this workspace yet. Once it’s enabled, come back to build your strategy automatically.',
              )}
            </Callout>
          </CardContent>
          <CardFooter className="justify-end border-t border-border pt-4">
            <Button variant="secondary" onClick={() => navigate('/studio/strategy')}>
              {t('strategy.onboarding.backToConsole', 'Back to Strategy')}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // step === 'done'
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <CheckCircle2 className="h-9 w-9 text-primary" aria-hidden="true" />
          <p className="text-base font-medium text-foreground">{t('strategy.onboarding.doneTitle', 'Your strategy is ready')}</p>
          <p className="text-sm text-muted-foreground">
            {t('strategy.onboarding.doneDesc', 'We drafted your strategy and a set of proposed actions — review and approve them in the Strategy console.')}
          </p>
        </CardContent>
        <CardFooter className="justify-center border-t border-border pt-4">
          <Button onClick={() => navigate('/studio/strategy')}>
            {t('strategy.onboarding.openConsole', 'Open Strategy console')}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
