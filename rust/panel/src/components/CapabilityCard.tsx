import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { BudgetItemOut, CapabilityOut, ConnectorHealth, GroupOut, Policy } from '@/api/types';
import { Chip } from '@/components/Chip';
import { ConnectorHealthBadge } from '@/components/ConnectorHealthBadge';
import { CapabilityStatusBadge } from '@/components/StatusBadges';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { kindLabel } from '@/lib/capabilities';
import { connectsByOAuth, providerOf } from '@/lib/connectors';
import { formatDateTime, formatHour, formatNumber, weekdayName } from '@/lib/format';

export type CapabilityAction = 'verify' | 'edit' | 'policy' | 'unreachable' | 'link' | 'retire';

/** What can be done about a connector capability's connection. */
export type ConnectorAction = 'connect' | 'reconnect' | 'probe';

/**
 * The connection actions that fit `item` for someone who may manage capabilities (`canManage`)
 * and probe (`canProbe`): connecting a declared one; reconnecting a Meta or X one that names its
 * account, or giving new credentials to a NetGSM one its probe no longer verifies; probing one
 * that holds credentials. None for a retired capability, nor for a kind no provider serves.
 */
export function connectorActions(item: CapabilityOut, canManage: boolean, canProbe: boolean): ConnectorAction[] {
  const c = item.capability;
  if (c.reach !== 'connector' || c.status === 'retired' || providerOf(c.kind_key) === null) return [];
  const actions: ConnectorAction[] = [];
  if (canManage && c.status === 'declared') actions.push('connect');
  const renewable = connectsByOAuth(c.kind_key) ? c.external_id !== null : c.status !== 'verified';
  if (canManage && c.status !== 'declared' && renewable) actions.push('reconnect');
  if (canProbe && c.has_sealed_config) actions.push('probe');
  return actions;
}

/** A policy in a few short lines: hours, caps, human approval, how long a verification lasts. */
export function policySummary(t: TFunction, language: string, policy: Policy): string[] {
  const lines: string[] = [];
  const hours = policy.active_hours;
  if (hours) {
    const days = [...hours.days].sort((a, b) => a - b).map((d) => weekdayName(d, language)).join(', ');
    lines.push(
      t('capabilities.policy.hours', { days, from: formatHour(hours.from), to: formatHour(hours.to), tz: hours.tz }),
    );
  } else {
    lines.push(t('capabilities.policy.anytime'));
  }
  if (policy.daily_ops_cap !== null) {
    lines.push(t('capabilities.policy.dailyCap', { count: policy.daily_ops_cap }));
  }
  if (policy.spend_cap_minor !== null) {
    lines.push(t('capabilities.policy.spendCap', { amount: formatNumber(policy.spend_cap_minor, language) }));
  }
  if (policy.requires_human_approval) lines.push(t('capabilities.policy.humanApproval'));
  lines.push(
    policy.verify_max_age_days === 0
      ? t('capabilities.policy.verifyNever')
      : t('capabilities.policy.verifyAge', { days: policy.verify_max_age_days }),
  );
  return lines;
}

/**
 * One capability: name, kind, how it is reached, its effective status, last verification, policy,
 * the budget items it spends from and the groups it is in. Actions show only for someone who may
 * take them, and never on a retired capability; a connector is verified by its probe, not here.
 */
export function CapabilityCard({
  item,
  budgetItems,
  groups,
  canManage,
  onAction,
  onUnlink,
  unlinking,
  health,
  canProbe = false,
  onConnector,
  connectorBusy = false,
}: {
  item: CapabilityOut;
  budgetItems: readonly BudgetItemOut[];
  groups: readonly GroupOut[];
  canManage: boolean;
  onAction: (action: CapabilityAction, item: CapabilityOut) => void;
  onUnlink: (item: CapabilityOut, budgetItemId: string) => void;
  unlinking: boolean;
  /** Its health, for a connector capability `connector.health` lists. */
  health?: ConnectorHealth;
  canProbe?: boolean;
  onConnector?: (action: ConnectorAction, item: CapabilityOut) => void;
  connectorBusy?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = item.capability;
  const retired = c.status === 'retired';
  const mutable = canManage && !retired;
  const connection = c.reach === 'connector' && !retired && providerOf(c.kind_key) !== null;
  const connecting = onConnector ? connectorActions(item, canManage, canProbe) : [];
  const budgetName = (id: string) => budgetItems.find((b) => b.item.id === id)?.item.name ?? id;
  const memberOf = groups.filter((g) => g.members.some((m) => m.capability.id === c.id));

  return (
    <Card className="flex flex-col" data-capability-id={c.id}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate" title={c.name}>
            {c.name}
          </CardTitle>
          <p className="text-caption text-muted-foreground">
            {kindLabel(t, c.kind_key)}{' '}
            <code className="font-mono text-micro">{c.kind_key}</code>
            {c.key_detail && <> · {t('capabilities.keyDetail', { detail: c.key_detail })}</>}
          </p>
        </div>
        <CapabilityStatusBadge status={item.effective_status} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {c.description && <p className="whitespace-pre-wrap text-sm text-foreground">{c.description}</p>}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-caption text-muted-foreground">{t('capabilities.reach.label')}</dt>
            <dd>
              <Badge size="sm">{t(`capabilities.reach.${c.reach}`)}</Badge>
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-caption text-muted-foreground">{t('capabilities.lastVerified')}</dt>
            <dd className="text-foreground">
              {c.last_verified_at
                ? formatDateTime(c.last_verified_at, i18n.language)
                : t('capabilities.neverVerified')}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-caption text-muted-foreground">{t('capabilities.policy.label')}</dt>
            <dd>
              <ul className="flex flex-col gap-0.5 text-foreground">
                {policySummary(t, i18n.language, c.policy).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-caption text-muted-foreground">{t('capabilities.budgetLinks')}</dt>
            <dd className="flex flex-wrap gap-1">
              {c.budget_item_ids.length === 0 ? (
                <span className="text-muted-foreground">{t('capabilities.noBudgetLinks')}</span>
              ) : (
                c.budget_item_ids.map((id) => (
                  <Chip
                    key={id}
                    label={budgetName(id)}
                    disabled={unlinking}
                    onRemove={mutable ? () => onUnlink(item, id) : undefined}
                    removeLabel={t('capabilities.actions.unlinkBudget', { name: budgetName(id) })}
                  />
                ))
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-caption text-muted-foreground">{t('capabilities.groupsLabel')}</dt>
            <dd className="flex flex-wrap gap-1">
              {memberOf.length === 0 ? (
                <span className="text-muted-foreground">{t('capabilities.noGroups')}</span>
              ) : (
                memberOf.map((g) => <Chip key={g.group.id} label={g.group.name} />)
              )}
            </dd>
          </div>
        </dl>
        {connection && (health || connecting.length > 0) && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-caption text-muted-foreground">{t('capabilities.connector.label')}</span>
              {health && <ConnectorHealthBadge health={health} />}
            </div>
            {connecting.length > 0 && onConnector && (
              <div role="group" aria-label={t('capabilities.connector.actionsLabel')} className="flex flex-wrap gap-2">
                {connecting.map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'probe' ? 'outline' : 'primary'}
                    disabled={connectorBusy}
                    onClick={() => onConnector(action, item)}
                  >
                    {t(`capabilities.connector.${action}`)}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {mutable && (
          <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
            {c.reach !== 'connector' && (
              <Button size="sm" onClick={() => onAction('verify', item)}>
                {t('capabilities.actions.verify')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => onAction('edit', item)}>
              {t('capabilities.actions.edit')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAction('policy', item)}>
              {t('capabilities.actions.policy')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAction('link', item)}>
              {t('capabilities.actions.linkBudget')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAction('unreachable', item)}>
              {t('capabilities.actions.unreachable')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAction('retire', item)}>
              {t('capabilities.actions.retire')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
