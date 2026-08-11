import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle, ChevronRight, X } from 'lucide-react';
import { useOnboardingChecklist } from '../hooks/useOnboardingChecklist';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  IconButton,
  Progress,
} from '@/components/ui';

/**
 * Manager-only first-run checklist. State lives in `useOnboardingChecklist` so
 * the dashboard can read the same signal and decide what to render FIRST — an
 * unconfigured workspace should not be told to "add your first lead" above the
 * setup guide.
 *
 * Dismissible, auto-hides once every step is complete, and dismissal latches
 * per-workspace in the persisted onboarding store so a configured workspace is
 * never nagged. "Show setup guide" in the header avatar menu reopens it.
 */
export default function GettingStarted() {
  const { t } = useTranslation('marketing');
  const { active, steps, done, total, allDone, dismiss } = useOnboardingChecklist();

  if (!active || allDone) return null;

  // The first outstanding step is the one to actually do next. Saying so beats
  // showing eight equal-weight rows and leaving the reader to pick.
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <Card data-testid="getting-started">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t('onboarding.title')}</CardTitle>
            <CardDescription className="mt-1">{t('onboarding.subtitle')}</CardDescription>
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('onboarding.dismiss')}
            onClick={dismiss}
            className="shrink-0 -mt-1 -me-1"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {/* Progress bar */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t('onboarding.progress', { done, total })}
          </p>
          <Progress value={(done / total) * 100} tone="primary" />
        </div>

        {/* Step list */}
        <div className="space-y-1.5">
          {steps.map((s, i) => {
            const isNext = i === nextIndex;
            return (
              <Link
                key={s.id}
                to={s.to}
                data-testid={isNext ? 'onboarding-next-step' : undefined}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                  isNext
                    ? 'border-primary bg-primary/5 hover:bg-primary/10'
                    : 'border-border hover:bg-surface-muted'
                }`}
              >
                {s.done ? (
                  <CheckCircle className="w-6 h-6 shrink-0 text-success" />
                ) : (
                  <span
                    className={`w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center text-xs font-semibold ${
                      isNext
                        ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground'
                    }`}
                  >
                    {i + 1}
                  </span>
                )}
                <span className="flex-1 min-w-0">
                  <span
                    className={`block font-medium text-sm ${
                      s.done ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                  >
                    {t(`onboarding.steps.${s.id}.title`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`onboarding.steps.${s.id}.desc`)}
                  </span>
                </span>
                {isNext && (
                  <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                    {t('onboarding.startHere', 'Buradan başla')}
                  </span>
                )}
                {!s.done && !isNext && (
                  <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                )}
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
