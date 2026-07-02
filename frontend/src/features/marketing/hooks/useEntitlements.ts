import { useQuery } from '@tanstack/react-query';
import marketingApi from '../api/marketingApi';
import type { FeatureKey } from '../navigation';

interface BillingSummary {
  entitlements?: {
    features?: Record<string, boolean>;
    /** Toggleable modules the plan entitles, BEFORE per-workspace activation. */
    entitledModules?: string[];
  };
}

/**
 * Resolves which optional modules the current workspace is entitled to, so the
 * navigation (and feature surfaces) can hide what the package doesn't include.
 *
 * Reuses the EXACT query key the dashboard/billing pages already use
 * (`['marketing','billing','summary']`), so React Query serves it from cache —
 * no extra request. `GET /billing/summary` is open to every role, so REPs get a
 * correct menu too. While loading or on error we fail CLOSED (gated items stay
 * hidden) — the whole point is to not surface modules the workspace can't use;
 * core items carry no `feature` and are always visible regardless.
 */
export function useEntitlements() {
  const { data, isLoading, isError } = useQuery<BillingSummary>({
    queryKey: ['marketing', 'billing', 'summary'],
    queryFn: () => marketingApi.get('/billing/summary').then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const features = data?.entitlements?.features ?? {};
  const entitledModules = data?.entitlements?.entitledModules ?? [];

  return {
    isLoading,
    isError,
    features,
    /** Toggleable modules the plan entitles (pre-activation) — drives the catalog. */
    entitledModules,
    /** No key → always true (core item). Otherwise true only when entitled. */
    has: (key?: FeatureKey) => (key ? !!features[key] : true),
  };
}
