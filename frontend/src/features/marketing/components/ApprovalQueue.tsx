import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  listPendingApprovals,
  approveRequest,
  rejectRequest,
  applyRequest,
  applyReallocation,
  isMcpApprovalPayload,
} from '../api/growthBudget.service';
import { fmtDateTime } from '../utils/format';
import { hasMarketingRole, MarketingRole } from '../types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

/**
 * The workspace's human-approval queue.
 *
 * This used to live inside BudgetAutopilotPage, which was the only screen that
 * rendered it — so every approval the AGENT queued (publish, send, spend) was
 * reachable only by opening the ad-budget page and finding a tab. An approval
 * nobody can find is not a gate, it is a dead end, and the whole MCP surface
 * depends on this queue being seen. It lives here now so the home screen and
 * the budget page render the same one.
 *
 * The three lanes below are load-bearing — see the comment on `approve`.
 */

export function ApprovalQueue() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pending-approvals'], queryFn: listPendingApprovals });
  /**
   * The read and the decision are gated differently, and until now only the
   * read was honoured. `GET /marketing/approvals` needs `reports.read`, which a
   * REP has — deliberately, so the person whose conversations the agent is
   * about to send into can see what is queued. Every decision route
   * (`:id/approve`, `:id/reject`, `:id/apply`, and budget's
   * `reallocations/:id/apply`) is `@MarketingRoles('MANAGER')` +
   * `settings.manage`. So a rep was handed three buttons that could only ever
   * 403, on the home screen they open every morning — and, once `/studio` was
   * listed for reps, on the Studio's right rail as well.
   *
   * Withhold the affordance and say why; do not let the 403 explain it. That is
   * the rule the rest of this surface already follows (IdeasPanel's
   * `canDecide`, TodayQueuePanel's `canAct`, AccountStatsPanel's `isManager`),
   * and this queue was the last component on the screen ignoring it.
   */
  const user = useMarketingAuthStore((s) => s.user);
  const canDecide = hasMarketingRole(user?.role, MarketingRole.MANAGER);
  const [confirmItem, setConfirmItem] = useState<{ id: string; kind: string } | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pending-approvals'] });
    // Approving a BUDGET_REALLOCATION rewrites each allocation's plannedAmount and
    // logs a run — so the detail view, budget list, activity and run history all
    // go stale unless refreshed too. Prefix keys cover the mounted budget's id
    // (this tab doesn't receive the budget id).
    qc.invalidateQueries({ queryKey: ['growth-budget'] });
    qc.invalidateQueries({ queryKey: ['growth-budgets'] });
    qc.invalidateQueries({ queryKey: ['budget-activity'] });
    qc.invalidateQueries({ queryKey: ['autopilot-runs'] });
  };
  // Three lanes, discriminated by PAYLOAD shape (never `kind` alone — an MCP
  // `jeeta.reallocate_budget` call shares the BUDGET_REALLOCATION kind with
  // the Budget Autopilot's own proposal loop, but carries a `{ tool, args }`
  // payload the reallocation executor can't read):
  //  1. MCP-originated (payload has `{ tool, args }`) — approve alone never
  //     touches the outside world; a human gate that only records a decision
  //     isn't a gate. So this calls approve, THEN POST /approvals/:id/apply,
  //     which runs the tool for real (send/publish/spend) through the broker.
  //     approve and apply are two separate network calls, so a row can arrive
  //     here already APPROVED (a previous apply failed, or the tab closed
  //     between the two) — skip re-approving in that case (decide() would
  //     reject re-deciding an already-decided request) and retry apply alone.
  //  2. Budget Autopilot reallocation (kind BUDGET_REALLOCATION, non-MCP
  //     payload) — apply() records the decision AND applies it in ONE call,
  //     with every precondition checked before the decision — so a failed
  //     apply (kill-switch on, paused budget) leaves the request PENDING and
  //     visible in the queue instead of stranded APPROVED-unapplied. It also
  //     accepts an already-APPROVED row (a retry) and just applies it.
  //  3. Everything else — approve only (no apply route exists/needed today).
  const approve = useMutation({
    mutationFn: async (r: { id: string; kind: string; payload?: unknown; status?: string }) => {
      if (isMcpApprovalPayload(r.payload)) {
        if (r.status !== 'APPROVED') {
          await approveRequest(r.id);
        }
        try {
          return { lane: 'mcp' as const, applied: await applyRequest(r.id) };
        } catch (e) {
          // The decision (approveRequest above, if it ran this call) is
          // recorded — only apply failed. Tag the error so onError says so
          // instead of the generic (and here false) "could not record your
          // decision"; the row stays APPROVED-unapplied and retryable.
          throw Object.assign(e instanceof Error ? e : new Error(String(e)), { approvedNotApplied: true });
        }
      }
      if (r.kind === 'BUDGET_REALLOCATION') {
        return { lane: 'reallocation' as const, applied: await applyReallocation(r.id) };
      }
      await approveRequest(r.id);
      return { lane: 'plain' as const, applied: null };
    },
    onSuccess: (outcome) => {
      if (outcome.lane === 'reallocation') {
        toast.success(
          outcome.applied.status === 'APPLIED'
            ? t('budget.appliedLive', { defaultValue: 'Approved & pushed live to the ad platform' })
            : t('budget.appliedPlan', { defaultValue: 'Approved & committed to the plan (connect an ad platform to push it live)' }),
        );
      } else if (outcome.lane === 'mcp') {
        toast.success(t('budget.mcpApplied', { defaultValue: 'Approved & applied' }));
      } else {
        toast.success(t('budget.approved', 'Approved'));
      }
      setConfirmItem(null);
      invalidate();
    },
    onError: (e: any) => {
      setConfirmItem(null);
      toast.error(
        e?.approvedNotApplied
          ? t('budget.mcpApplyError', {
              defaultValue: 'Approved — but applying it failed. The decision was recorded; retry Apply to finish it.',
            })
          : // Surface the server's reason (e.g. "Budget is not active") — the
            // request is still PENDING in that case, so the manager can fix and retry.
            (e?.response?.data?.message ?? t('budget.decisionError', 'Could not record your decision')),
      );
      invalidate();
    },
  });
  const reject = useMutation({
    mutationFn: rejectRequest,
    onSuccess: () => { toast.success(t('budget.rejected', 'Rejected')); invalidate(); },
    onError: () => toast.error(t('budget.decisionError', 'Could not record your decision')),
  });

  return (
    <>
      <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {!q.data?.length ? (
          <EmptyState icon={<Check className="h-5 w-5" />} title={t('budget.noApprovals.title', 'Nothing waiting')} description={t('budget.noApprovals.desc', 'Autopilot proposals and other high-risk actions land here for your sign-off.')} />
        ) : (
          <div className="space-y-2">
            {q.data.map((r) => {
              const mcpPayload = isMcpApprovalPayload(r.payload) ? r.payload : null;
              // Only a genuine Budget Autopilot proposal takes the confirm-dialog
              // + applyReallocation path — an MCP jeeta.reallocate_budget request
              // shares the kind but not the payload shape, so it's routed as MCP.
              const isAutopilotReallocation = !mcpPayload && r.kind === 'BUDGET_REALLOCATION';
              // listPendingApprovals now also returns APPROVED-but-not-yet-APPLIED
              // rows (the decision was made, the apply/execute step hasn't run or
              // failed and can be retried) — those get an Apply affordance, never
              // Approve/Reject again: re-approving an already-decided request 400s,
              // and reject() only ever claims a still-PENDING row.
              const approvedUnapplied = r.status === 'APPROVED';
              return (
                <Card key={r.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone="info">{t(`budget.kind.${r.kind}`, r.kind)}</Badge>
                        {approvedUnapplied && (
                          <Badge tone="warning">{t('budget.approvedUnapplied', 'Approved — not applied yet')}</Badge>
                        )}
                        <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                      </div>
                      <p className="mt-1 truncate text-sm">{r.summary}</p>
                      {/* The human gate is only real if the operator can see what
                          they're approving before they click — a customer-facing
                          send/publish/spend call's actual tool + arguments, not
                          just the generic summary sentence. */}
                      {mcpPayload && (
                        <div className="mt-2 max-w-md rounded-md border border-border bg-muted/30 p-2 text-xs">
                          <p className="font-mono font-medium text-foreground">{mcpPayload.tool}</p>
                          <dl className="mt-1 space-y-0.5">
                            {Object.entries(mcpPayload.args).map(([key, value]) => (
                              <div key={key} className="flex gap-1.5">
                                <dt className="shrink-0 text-muted-foreground">{key}:</dt>
                                <dd className="break-all text-foreground">
                                  {typeof value === 'string' ? value : JSON.stringify(value)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!canDecide ? (
                        /* One line where the two buttons were, per row rather
                           than once per queue: the rows are cards, and a note
                           under the list would sit too far from the thing it
                           is explaining to be read as its explanation. */
                        <p data-testid="approvals-readonly" className="text-xs text-muted-foreground">
                          {t(
                            'budget.approvals.readOnly',
                            'Onaylamak için yönetici yetkisi gerekiyor — burada yalnızca bekleyenleri görebilirsin.',
                          )}
                        </p>
                      ) : (
                        <>
                          {!approvedUnapplied && (
                            <Button variant="secondary" size="sm" onClick={() => reject.mutate(r.id)} disabled={reject.isPending}>
                              <X className="mr-1 h-4 w-4" aria-hidden="true" />{t('budget.reject', 'Reject')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            onClick={() =>
                              isAutopilotReallocation
                                ? setConfirmItem({ id: r.id, kind: r.kind })
                                : approve.mutate({ id: r.id, kind: r.kind, payload: r.payload, status: r.status })
                            }
                            disabled={approve.isPending}
                          >
                            <Check className="mr-1 h-4 w-4" aria-hidden="true" />
                            {approvedUnapplied ? t('budget.apply', 'Apply') : t('budget.approve', 'Approve')}
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </QueryStateBoundary>

      <ConfirmDialog
        open={confirmItem !== null}
        onOpenChange={(o) => { if (!o) setConfirmItem(null); }}
        tone="danger"
        title={t('budget.approveConfirm.title', 'Push this reallocation live?')}
        description={t('budget.approveConfirm.desc', 'Approving commits the plan and pushes the new budget live to the ad platform where connected — real spend moves and there’s no undo.')}
        confirmLabel={t('budget.approveConfirm.confirm', 'Approve & push live')}
        cancelLabel={t('common.cancel', 'Cancel')}
        loading={approve.isPending}
        onConfirm={() => { if (confirmItem) approve.mutate(confirmItem); }}
      />
    </>
  );
}
