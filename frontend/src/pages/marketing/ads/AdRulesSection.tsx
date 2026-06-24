import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Play, Pencil, Trash2, ScrollText, Zap, ChevronDown, ChevronRight, Check, X } from 'lucide-react';
import {
  listAdRules,
  getAdRuleLogs,
  createAdRule,
  updateAdRule,
  deleteAdRule,
  runAdRule,
  type AdAccount,
  type AdRule,
} from '../../../features/marketing/api/ads.service';
import { RuleDialog } from './RuleDialog';
import {
  type RuleFormOutput,
  METRIC_LABEL,
  OPERATOR_SYMBOL,
  ACTION_LABEL,
  BUDGET_ACTIONS,
} from './adManagementSchemas';
import { fmtDateTime } from '../../../features/marketing/utils/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Switch } from '@/components/ui/Switch';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

interface AdRulesSectionProps {
  /** Meta accounts available as rule targets. */
  accounts: AdAccount[];
  /** Currently selected account — used to pre-fill new rules. */
  selectedAccountId?: string;
}

/** Build the human-readable "WHEN … THEN …" summary for a rule. */
function ruleSummary(rule: AdRule, t: (k: string, o: { defaultValue: string }) => string): string {
  const metric = t(`ads.metric.${rule.metric}`, { defaultValue: METRIC_LABEL[rule.metric] });
  const action = t(`ads.action.${rule.action}`, { defaultValue: ACTION_LABEL[rule.action] });
  const pct = BUDGET_ACTIONS.has(rule.action) && rule.actionValue != null ? ` ${rule.actionValue}%` : '';
  return `${metric} ${OPERATOR_SYMBOL[rule.operator]} ${rule.threshold} · ${rule.windowDays}d → ${action}${pct}`;
}

export function AdRulesSection({ accounts, selectedAccountId }: AdRulesSectionProps) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AdRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdRule | null>(null);
  const [expandedLogsId, setExpandedLogsId] = useState<string | null>(null);

  const rulesKey = ['marketing', 'ads', 'rules'];

  const { data, isLoading } = useQuery({
    queryKey: rulesKey,
    queryFn: listAdRules,
  });
  const rules: AdRule[] = Array.isArray(data) ? data : [];

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: rulesKey });

  const createMutation = useMutation({
    mutationFn: (values: RuleFormOutput) => createAdRule(values),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      toast.success(t('ads.rules.toast.created', { defaultValue: 'Rule created' }));
    },
    onError: () => toast.error(t('ads.rules.toast.createFailed', { defaultValue: 'Failed to create rule' })),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: RuleFormOutput }) => {
      // adAccountId cannot be patched.
      const { adAccountId: _omit, ...patch } = values;
      void _omit;
      return updateAdRule(id, patch);
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditingRule(null);
      toast.success(t('ads.rules.toast.updated', { defaultValue: 'Rule updated' }));
    },
    onError: () => toast.error(t('ads.rules.toast.updateFailed', { defaultValue: 'Failed to update rule' })),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateAdRule(id, { enabled }),
    onSuccess: () => invalidate(),
    onError: () => toast.error(t('ads.rules.toast.updateFailed', { defaultValue: 'Failed to update rule' })),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdRule(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('ads.rules.toast.deleted', { defaultValue: 'Rule deleted' }));
    },
    onError: () => toast.error(t('ads.rules.toast.deleteFailed', { defaultValue: 'Failed to delete rule' })),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => runAdRule(id),
    onSuccess: (res) => {
      invalidate();
      const applied = res.actions.filter((a) => a.ok).length;
      if (res.actions.length === 0) {
        toast.success(t('ads.rules.toast.runNoMatch', { defaultValue: 'Rule ran — no entities matched' }));
      } else {
        toast.success(
          t('ads.rules.toast.ran', {
            defaultValue: '{{count}} action(s) applied',
            count: applied,
          }),
        );
      }
      if (expandedLogsId) {
        queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'ruleLogs', expandedLogsId] });
      }
    },
    onError: () => toast.error(t('ads.rules.toast.runFailed', { defaultValue: 'Failed to run rule' })),
  });

  const openCreate = () => {
    setEditingRule(null);
    setDialogOpen(true);
  };
  const openEdit = (rule: AdRule) => {
    setEditingRule(rule);
    setDialogOpen(true);
  };

  const handleSubmit = (values: RuleFormOutput) => {
    if (editingRule) updateMutation.mutate({ id: editingRule.id, values });
    else createMutation.mutate(values);
  };

  const noMetaAccounts = accounts.length === 0;

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">
          {t('ads.rules.title', { defaultValue: 'Scaling rules' })}
        </h3>
        <Button size="sm" onClick={openCreate} disabled={noMetaAccounts}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('ads.rules.newRule', { defaultValue: 'New rule' })}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-10 w-10" />}
          title={t('ads.rules.empty', { defaultValue: 'No scaling rules yet' })}
          description={t('ads.rules.emptyHint', {
            defaultValue: 'Create a rule to automatically scale budgets or pause campaigns based on performance.',
          })}
          action={
            <Button variant="outline" onClick={openCreate} disabled={noMetaAccounts}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('ads.rules.newRule', { defaultValue: 'New rule' })}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {rules.map((rule) => {
            const expanded = expandedLogsId === rule.id;
            const runPending = runMutation.isPending && runMutation.variables === rule.id;
            return (
              <li key={rule.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground">{rule.name}</p>
                      {!rule.enabled && (
                        <Badge tone="neutral" size="sm">
                          {t('ads.rules.disabled', { defaultValue: 'Disabled' })}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">{ruleSummary(rule, t)}</p>
                    <p className="mt-0.5 text-micro text-muted-foreground">
                      {accountName(rule.adAccountId)}
                      {' · '}
                      {rule.lastTriggeredAt
                        ? t('ads.rules.lastTriggered', {
                            defaultValue: 'Last triggered {{when}}',
                            when: fmtDateTime(rule.lastTriggeredAt),
                          })
                        : t('ads.rules.neverTriggered', { defaultValue: 'Never triggered' })}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(enabled) => toggleMutation.mutate({ id: rule.id, enabled })}
                      aria-label={t('ads.rules.toggle', { defaultValue: 'Enable rule' })}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      loading={runPending}
                      onClick={() => runMutation.mutate(rule.id)}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('ads.rules.runNow', { defaultValue: 'Run now' })}
                    </Button>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('ads.rules.viewLogs', { defaultValue: 'View logs' })}
                      onClick={() => setExpandedLogsId(expanded ? null : rule.id)}
                    >
                      {expanded ? (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      )}
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('common.edit', { defaultValue: 'Edit' })}
                      onClick={() => openEdit(rule)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('common.delete', { defaultValue: 'Delete' })}
                      onClick={() => setDeleteTarget(rule)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>

                {expanded && <RuleLogs ruleId={rule.id} />}
              </li>
            );
          })}
        </ul>
      )}

      <RuleDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingRule(null);
        }}
        accounts={accounts}
        rule={editingRule}
        defaultAdAccountId={selectedAccountId}
        onSubmit={handleSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('ads.rules.confirm.deleteTitle', { defaultValue: 'Delete rule' })}
        description={t('ads.rules.confirm.deleteBody', {
          defaultValue: 'This permanently removes the rule and its run history. This cannot be undone.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        loading={deleteMutation.isPending}
      />
    </Card>
  );
}

function RuleLogs({ ruleId }: { ruleId: string }) {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'ads', 'ruleLogs', ruleId],
    queryFn: () => getAdRuleLogs(ruleId),
  });
  const logs = Array.isArray(data) ? data : [];

  if (isLoading) {
    return <Skeleton className="mt-3 h-16" />;
  }

  if (logs.length === 0) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-md bg-surface-muted px-3 py-3 text-caption text-muted-foreground">
        <ScrollText className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t('ads.rules.logs.empty', { defaultValue: 'No runs recorded yet.' })}
      </div>
    );
  }

  return (
    <ul className="mt-3 space-y-1.5 rounded-md bg-surface-muted p-3">
      {logs.map((log) => (
        <li key={log.id} className="flex items-start gap-2 text-caption">
          {log.ok ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <span className="text-foreground">
              {log.entityName ?? log.entityId} — {log.action}
            </span>
            {log.detail && <span className="text-muted-foreground"> · {log.detail}</span>}
          </div>
          <span className="shrink-0 text-micro text-muted-foreground">{fmtDateTime(log.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
