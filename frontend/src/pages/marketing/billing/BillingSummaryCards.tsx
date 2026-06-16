/**
 * BillingSummaryCards — current plan, lead quota, AI credits, limits.
 * Pure presentation; receives data props from the parent.
 */
import { useTranslation } from 'react-i18next';
import { StatCard } from '@/components/ui/StatCard';
import { Badge } from '@/components/ui/Badge';
import { Progress } from '@/components/ui/Progress';
import { Card, CardContent } from '@/components/ui/Card';
import { Users, BookOpen, Bot, FileText } from 'lucide-react';

interface Sub {
  packageName?: string;
  status?: string;
  trialEndsAt?: string;
  currentPeriodEnd?: string;
  packageCode?: string;
}
interface Ent {
  maxUsers?: number;
  maxResearchProfiles?: number;
  limits?: { maxAgents?: number; maxKnowledgeDocs?: number };
}
interface Usage { used: number; limit: number }

interface Props {
  sub?: Sub;
  ent?: Ent;
  usage?: Usage;
  aiUsage?: Usage;
  summaryLoading: boolean;
}

function subBadgeTone(status?: string): 'success' | 'info' | 'warning' | 'neutral' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'TRIALING') return 'info';
  if (status === 'PAST_DUE') return 'warning';
  return 'neutral';
}

export function BillingSummaryCards({ sub, ent, usage, aiUsage, summaryLoading }: Props) {
  const { t } = useTranslation('marketing');

  const quotaPct =
    usage && usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const aiPct =
    aiUsage && aiUsage.limit > 0
      ? Math.min(100, Math.round((aiUsage.used / aiUsage.limit) * 100))
      : 0;

  if (summaryLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-surface-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      {/* Current plan */}
      <Card className="flex flex-col gap-2 p-5">
        <p className="text-micro uppercase tracking-wide text-muted-foreground">
          {t('billing.currentPlan', 'Current plan')}
        </p>
        <p className="font-display text-h2 text-foreground">
          {sub?.packageName ?? t('billing.noPlan', 'No plan')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {sub?.status && (
            <Badge tone={subBadgeTone(sub.status)} size="sm">
              {sub.status}
            </Badge>
          )}
          {sub?.status === 'TRIALING' && sub.trialEndsAt && (
            <span className="text-xs text-muted-foreground">
              {t('billing.trialEnds', 'trial ends')}{' '}
              {new Date(sub.trialEndsAt).toLocaleDateString()}
            </span>
          )}
          {sub?.status === 'ACTIVE' && sub.currentPeriodEnd && (
            <span className="text-xs text-muted-foreground">
              {t('billing.renews', 'renews')}{' '}
              {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </span>
          )}
        </div>
      </Card>

      {/* Lead quota */}
      <Card className="flex flex-col gap-2 p-5">
        <p className="text-micro uppercase tracking-wide text-muted-foreground">
          {t('research.quotaToday', "Today's lead quota")}
        </p>
        <p className="font-display text-h2 tabular-nums text-foreground">
          {usage
            ? usage.limit === -1
              ? `${usage.used} / ∞`
              : `${usage.used} / ${usage.limit}`
            : '…'}
        </p>
        <Progress
          value={usage?.limit === -1 ? 8 : quotaPct}
          tone={quotaPct >= 100 ? 'warning' : 'primary'}
        />
      </Card>

      {/* AI credits */}
      <Card className="flex flex-col gap-2 p-5">
        <p className="text-micro uppercase tracking-wide text-muted-foreground">
          {t('billing.aiCredits', 'AI credits this month')}
        </p>
        <p className="font-display text-h2 tabular-nums text-foreground">
          {aiUsage
            ? aiUsage.limit === -1
              ? `${aiUsage.used} / ∞`
              : `${aiUsage.used} / ${aiUsage.limit}`
            : '…'}
        </p>
        <Progress
          value={aiUsage?.limit === -1 ? 8 : aiPct}
          tone={aiPct >= 100 ? 'warning' : 'primary'}
        />
        <p className="text-xs text-muted-foreground">
          {t('billing.aiCreditsHint', 'Resets monthly. Add a boost below to raise the cap.')}
        </p>
      </Card>

      {/* Limits */}
      <Card>
        <CardContent className="pt-5">
          <p className="text-micro uppercase tracking-wide text-muted-foreground mb-3">
            {t('billing.limits', 'Limits')}
          </p>
          <ul className="space-y-1.5 text-sm text-foreground">
            <li className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">{t('billing.seats', 'Seats')}</span>
              <strong className="ml-auto tabular-nums">
                {ent?.maxUsers === -1 ? '∞' : ent?.maxUsers ?? '—'}
              </strong>
            </li>
            <li className="flex items-center gap-2">
              <BookOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">
                {t('billing.profiles', 'Research profiles')}
              </span>
              <strong className="ml-auto tabular-nums">
                {ent?.maxResearchProfiles === -1 ? '∞' : ent?.maxResearchProfiles ?? '—'}
              </strong>
            </li>
            <li className="flex items-center gap-2">
              <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">{t('billing.agents', 'AI agents')}</span>
              <strong className="ml-auto tabular-nums">
                {ent?.limits?.maxAgents === -1 ? '∞' : ent?.limits?.maxAgents ?? '—'}
              </strong>
            </li>
            <li className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">
                {t('billing.knowledgeDocs', 'Knowledge docs')}
              </span>
              <strong className="ml-auto tabular-nums">
                {ent?.limits?.maxKnowledgeDocs === -1 ? '∞' : ent?.limits?.maxKnowledgeDocs ?? '—'}
              </strong>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
