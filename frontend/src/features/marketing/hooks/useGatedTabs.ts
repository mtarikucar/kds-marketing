import { useMemo } from 'react';
import type { FeatureKey } from '../navigation';
import { useEntitlements } from './useEntitlements';

/** One tab of a merged page, as the page itself declares it. */
export interface GatedTab {
  /** The `?tab=` value. */
  value: string;
  /** The entitlement this half needs, when it is stricter than the page's. */
  feature?: FeatureKey;
}

/**
 * Drop the tabs this workspace has not bought.
 *
 * Several pages that became tabs carried an entitlement gate of their own —
 * `/calls` needed `telephony`, `/automations` needed `workflows`, `/invoices`
 * needed `invoicing`, `/booking` needed `funnels`. Folding them into a page
 * with a different (or no) gate silently drops that check, and the workspace is
 * offered a tab for a feature it does not have: a click, a blank panel or a
 * 403, and no explanation. That is a worse list than the long one this merge
 * replaced — a list you cannot use is a list that lies.
 *
 * Returns the surviving tab values in declaration order, plus the one to open
 * when the requested tab is missing or gone. The fallback matters: a bookmark
 * to `?tab=invoices` from a workspace that has since dropped invoicing must
 * land somewhere real rather than on an empty page.
 */
export function useGatedTabs(tabs: readonly GatedTab[], requested: string | null) {
  const { has } = useEntitlements();
  return useMemo(() => {
    const allowed = tabs.filter((t) => has(t.feature)).map((t) => t.value);
    // `has` is asked for every tab, so a page whose every half is gated off
    // still returns a first value rather than undefined — the caller renders an
    // empty tab list, which is honest, instead of crashing on a missing tab.
    const active = requested && allowed.includes(requested) ? requested : allowed[0] ?? '';
    return { allowed, active };
  }, [tabs, requested, has]);
}
