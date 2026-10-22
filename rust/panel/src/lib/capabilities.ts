import type { TFunction } from 'i18next';
import {
  KINDS,
  type BudgetKind,
  type CapabilityKind,
  type KindGroup,
  type KindKey,
  type UnitKind,
} from '@/api/types';

// The capability rules the panel needs to offer only what the server accepts, mirrored from
// `jt_capability` (`requires_key_detail`, `unit_fits`, `can_link_budget`). The server checks
// again; these only shape the forms.

export function isKindKey(key: string): key is KindKey {
  return KINDS.some((k) => k.key === key);
}

/** The kind with this key, if it is on the closed list. */
export function kindOf(key: string): CapabilityKind | undefined {
  return KINDS.find((k) => k.key === key);
}

/** The kinds of group `group`, in the order of `KINDS`. */
export function kindsInGroup(group: KindGroup): CapabilityKind[] {
  return KINDS.filter((k) => k.group === group);
}

/** A kind as shown; a kind that left the list shows as its key. */
export function kindLabel(t: TFunction, key: string): string {
  return isKindKey(key) ? t(`capabilities.kinds.${key}`) : key;
}

/** Only the third-party kind `other` needs a `key_detail` naming the tool. */
export function requiresKeyDetail(key: string): boolean {
  return kindOf(key)?.group === 'third_party' && key === 'other';
}

/** `unit_fits`: the unit kinds a budget item of `kind` may be counted in. */
export function unitKindsFor(kind: BudgetKind): UnitKind[] {
  switch (kind) {
    case 'cash':
    case 'ad_budget':
    case 'sms_budget':
      return ['currency'];
    case 'consumable':
    case 'agent_quota':
      return ['count'];
    case 'agent_hours':
      return ['minutes'];
  }
}

/** `can_link_budget`: whether a capability of kind `key` may spend from a `budgetKind` item. */
export function canLinkBudget(key: string, budgetKind: BudgetKind): boolean {
  const kind = kindOf(key);
  if (!kind) return budgetKind === 'cash';
  if (kind.group === 'ads') return budgetKind === 'ad_budget' || budgetKind === 'cash';
  if (kind.group === 'agent_connection') return budgetKind === 'agent_quota' || budgetKind === 'agent_hours';
  if (kind.key === 'sms_line') return budgetKind === 'sms_budget' || budgetKind === 'cash';
  if (kind.key === 'printer' || kind.key === 'printer_3d') {
    return budgetKind === 'consumable' || budgetKind === 'cash';
  }
  return budgetKind === 'cash';
}
