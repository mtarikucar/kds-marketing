import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Compass, Sparkles, Check, X } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Button,
  Callout,
  Progress,
  Spinner,
  EmptyState,
  SegmentedControl,
} from '@/components/ui';
import {
  getStrategy,
  listStrategyActions,
  approveAction,
  dismissAction,
  setStrategyAutonomy,
  type AutonomyLevel,
  type StrategyAction,
} from '../../../features/marketing/api/strategy.service';

const AUTONOMY_LEVELS: AutonomyLevel[] = ['SHADOW', 'ASSISTED', 'AUTONOMOUS'];

/**
 * Strategy console (Task 9) — renders the AI-drafted MarketingStrategy brief
 * (archetype, audience, channel fit, content pillars, goals, budget), the
 * ActionPlan approval queue (approve / dismiss PROPOSED actions), and the
 * autonomy lane selector. When no strategy exists yet it shows a CTA into the
 * onboarding wizard.
 */
export default function StrategyConsolePage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const strategyQuery = useQuery({
    queryKey: ['marketing', 'strategy'],
    queryFn: getStrategy,
  });

  const strategy = strategyQuery.data ?? null;

  const actionsQuery = useQuery({
    queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'],
    queryFn: () => listStrategyActions('PROPOSED'),
    enabled: !!strategy,
  });

  const invalidateActions = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'] });

  // Track the row-level pending action so one card's spinner doesn't bleed onto
  // every row (shared-mutation isPending bug class).
  const approve = useMutation({
    mutationFn: (id: string) => approveAction(id),
    onSuccess: () => {
      toast.success(t('strategy.console.actionApproved', 'Action approved'));
      invalidateActions();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('strategy.console.actionFailed', 'Something went wrong')),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAction(id),
    onSuccess: () => {
      toast.success(t('strategy.console.actionDismissed', 'Action dismissed'));
      invalidateActions();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('strategy.console.actionFailed', 'Something went wrong')),
  });

  const autonomy = useMutation({
    mutationFn: (level: AutonomyLevel) => setStrategyAutonomy(level),
    onSuccess: (updated) => {
      queryClient.setQueryData(['marketing', 'strategy'], updated);
      toast.success(t('strategy.console.autonomySaved', 'Autonomy updated'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('strategy.console.actionFailed', 'Something went wrong')),
  });

  const autonomyLabel = (level: AutonomyLevel) =>
    ({
      SHADOW: t('strategy.console.autonomy.shadow', 'Shadow'),
      ASSISTED: t('strategy.console.autonomy.assisted', 'Assisted'),
      AUTONOMOUS: t('strategy.console.autonomy.autonomous', 'Autonomous'),
    })[level];

  // ── loading / empty ─────────────────────────────────────────────────────────
  if (strategyQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-6 w-6 text-primary" />
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <EmptyState
          icon={<Compass className="h-8 w-8" />}
          title={t('strategy.console.emptyTitle', 'No strategy yet')}
          description={t(
            'strategy.console.emptyDesc',
            'Let the AI strategist analyze your brand and draft a full marketing strategy with an action plan.',
          )}
          action={
            <Button onClick={() => navigate('/onboarding/strategy')}>
              <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('strategy.console.startOnboarding', 'Build my strategy')}
            </Button>
          }
        />
      </div>
    );
  }

  const brief = strategy.brief ?? ({} as typeof strategy.brief);
  const actions = actionsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      {/* Header + archetype + autonomy */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-h2 text-foreground">{t('strategy.console.title', 'Strategy')}</h1>
            {strategy.archetype && <Badge tone="primary">{strategy.archetype}</Badge>}
            <Badge tone={strategy.status === 'ACTIVE' ? 'success' : 'neutral'}>{strategy.status}</Badge>
          </div>
          {brief.identity?.positioning && (
            <p className="max-w-2xl text-sm text-muted-foreground">{brief.identity.positioning}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <p className="text-caption font-medium text-muted-foreground">{t('strategy.console.autonomyLabel', 'Autonomy')}</p>
          <SegmentedControl<AutonomyLevel>
            aria-label={t('strategy.console.autonomyLabel', 'Autonomy')}
            value={strategy.autonomyLevel}
            onChange={(level) => autonomy.mutate(level)}
            options={AUTONOMY_LEVELS.map((level) => ({ value: level, label: autonomyLabel(level) }))}
          />
        </div>
      </div>

      {/* Identity */}
      {brief.identity && (
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.console.identity', 'Identity')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Detail label={t('strategy.console.product', 'Product')} value={brief.identity.product} />
            <Detail label={t('strategy.console.voice', 'Voice')} value={brief.identity.voice} />
            <Detail label={t('strategy.console.usp', 'USP')} value={brief.identity.usp} />
            <Detail label={t('strategy.console.audience', 'Audience')} value={brief.audience} />
          </CardContent>
        </Card>
      )}

      {/* Channels */}
      {brief.channels && brief.channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.console.channels', 'Channels')}</CardTitle>
            <CardDescription>{t('strategy.console.channelsDesc', 'Where to focus, ranked by fit.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {brief.channels.map((c) => (
              <div key={c.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{c.key}</span>
                  <span className="text-caption text-muted-foreground">{c.fitScore}</span>
                </div>
                <Progress value={c.fitScore} />
                {c.rationale && <p className="text-caption text-muted-foreground">{c.rationale}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Content pillars */}
      {brief.contentPillars && brief.contentPillars.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.console.pillars', 'Content pillars')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {brief.contentPillars.map((p, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-border p-3.5">
                <p className="text-sm font-medium text-foreground">{p.title}</p>
                {p.angle && <p className="text-caption text-muted-foreground">{p.angle}</p>}
                {p.formats && p.formats.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {p.formats.map((f) => (
                      <Badge key={f} tone="neutral" size="sm">
                        {f}
                      </Badge>
                    ))}
                  </div>
                )}
                {p.tone && (
                  <p className="text-micro text-muted-foreground">
                    {t('strategy.console.pillarTone', 'Tone: {{tone}}', { tone: p.tone })}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Goals + budget + competitors */}
      {(brief.goals || brief.budget || (brief.competitors && brief.competitors.length > 0)) && (
        <Card>
          <CardHeader>
            <CardTitle>{t('strategy.console.goals', 'Goals & budget')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {brief.goals?.objective && <Detail label={t('strategy.console.objective', 'Objective')} value={brief.goals.objective} />}
            {brief.goals?.kpis && brief.goals.kpis.length > 0 && (
              <div className="space-y-1">
                <p className="text-caption font-medium text-muted-foreground">{t('strategy.console.kpis', 'KPIs')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {brief.goals.kpis.map((k) => (
                    <Badge key={k} tone="info" size="sm">
                      {k}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {brief.budget && <Detail label={t('strategy.console.budget', 'Budget')} value={brief.budget} />}
            {brief.competitors && brief.competitors.length > 0 && (
              <div className="space-y-1">
                <p className="text-caption font-medium text-muted-foreground">{t('strategy.console.competitors', 'Competitors')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {brief.competitors.map((c) => (
                    <Badge key={c} tone="neutral" size="sm">
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Action plan approval queue */}
      <Card>
        <CardHeader>
          <CardTitle>{t('strategy.console.actionPlan', 'Action plan')}</CardTitle>
          <CardDescription>{t('strategy.console.actionPlanDesc', 'Proposed next moves — approve to queue them, or dismiss.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {actionsQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5 text-primary" />
            </div>
          ) : actions.length === 0 ? (
            <Callout tone="info">{t('strategy.console.noActions', 'No proposed actions right now.')}</Callout>
          ) : (
            actions.map((a: StrategyAction) => {
              const busy = (approve.isPending && approve.variables === a.id) || (dismiss.isPending && dismiss.variables === a.id);
              return (
                <div key={a.id} className="flex flex-col gap-3 rounded-lg border border-border p-3.5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral" size="sm">{a.kind}</Badge>
                      <span className="text-sm font-medium text-foreground">{a.title}</span>
                    </div>
                    {a.rationale && <p className="text-caption text-muted-foreground">{a.rationale}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => approve.mutate(a.id)}
                      disabled={busy}
                      loading={approve.isPending && approve.variables === a.id}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t('strategy.console.approve', 'Approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dismiss.mutate(a.id)}
                      disabled={busy}
                      loading={dismiss.isPending && dismiss.variables === a.id}
                    >
                      <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t('strategy.console.dismiss', 'Dismiss')}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-caption font-medium text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}
