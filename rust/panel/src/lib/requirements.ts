import type { TFunction } from 'i18next';
import { isKindKey } from './capabilities';

/** Capability groups a requirement expression may name (`jt_capability::KindGroup`). */
export const CAPABILITY_GROUPS = [
  'social_account', 'messaging', 'telephony', 'community', 'ads', 'calendar', 'marketplace',
  'device', 'agent_connection', 'computer_access', 'third_party',
] as const;
export type CapabilityGroupKey = (typeof CAPABILITY_GROUPS)[number];
export function isGroupKey(key: string): key is CapabilityGroupKey {
  return (CAPABILITY_GROUPS as readonly string[]).includes(key);
}

/** A requirement line's alternatives when it gates (kind or group keys joined by `|`), else null. */
export function requirementTerms(line: string): string[] | null {
  const terms = line.split('|').map(term => term.trim());
  if (terms.some(term => !term || !(isKindKey(term) || isGroupKey(term)))) return null;
  return new Set(terms).size === terms.length ? terms : null;
}

/** A requirement in words: "Mesajlaşma", or "E-posta kutusu, SMS hattı veya WhatsApp Business". */
export function requirementLabel(t: TFunction, line: string, or: string): string {
  const terms = requirementTerms(line);
  if (!terms) return line;
  const labels = terms.map(term => isGroupKey(term) ? t(`capabilities.groups.${term}`) : t(`capabilities.kinds.${term}` as never));
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} ${or} ${labels[labels.length - 1]}` : labels[0];
}
