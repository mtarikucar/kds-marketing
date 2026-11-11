import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { formatMoney } from '@/lib/format';
import { Reason, StudioError, useStudioMutation } from '../StudioShared';

export function PendingBudgetMoves({ data, manage }: { data: api.Overview; manage: boolean }) {
  const { t, i18n } = useTranslation();
  const approve = useStudioMutation(({ target, revision }: { target: api.Target; revision: number }) => api.approve(target, revision));
  return <div className="space-y-4">
      {data?.today.budget_moves.map((m) => (
        <div key={m.id} className="space-y-4 border-b border-border pb-6">
          <p className="text-sm">
            {t('studio.dailyBudget')}: {formatMoney(m.daily_budget_minor, m.currency, i18n.language)} ·{' '}
            {t(`studio.budgetState.${m.state}`)}
          </p>
          {data.today.blockers
            .filter((b) => 'budget_move' in b.target && b.target.budget_move === m.id)
            .map((b, i) => (
              <Reason key={i} reason={b.reason} />
            ))}
          {manage &&
            data.today.approvals.some((a) => 'budget_move' in a && a.budget_move === m.id) && (
              <button
                className="min-h-10 rounded-md border border-primary bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={approve.isPending}
                onClick={() =>
                  approve.mutate({ target: { budget_move: m.id }, revision: m.revision })
                }
              >
                {t('studio.approve')}
              </button>
            )}
        </div>
      ))}
      {data?.today.paid_alerts.map((a) => (
        <div key={a.binding_id}>
          <Reason reason={a.reason} />
          {a.residual_provider_exposure && <p className="text-sm">{t('studio.exposure')}</p>}
        </div>
      ))}
    <StudioError error={approve.error} />
  </div>;
}
