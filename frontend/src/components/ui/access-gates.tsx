import type { ReactNode } from 'react';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import { hasMarketingRole, type MarketingRole } from '@/features/marketing/types';
import { useEntitlements } from '@/features/marketing/hooks/useEntitlements';
import type { FeatureKey } from '@/features/marketing/navigation';

// ── RoleGate ────────────────────────────────────────────────────────────────

export interface RoleGateProps {
  /** Minimum role required to see the children. */
  role: MarketingRole;
  children: ReactNode;
  /** Rendered when the user's role is insufficient. Defaults to null. */
  fallback?: ReactNode;
}

/**
 * Renders `children` when the authenticated user's role satisfies the
 * `role` requirement (using the hierarchical `hasMarketingRole` check).
 * Falls back to `fallback ?? null` otherwise.
 */
export function RoleGate({ role, children, fallback = null }: RoleGateProps) {
  const user = useMarketingAuthStore((s) => s.user);
  return hasMarketingRole(user?.role, role) ? <>{children}</> : <>{fallback}</>;
}

// ── FeatureGate ─────────────────────────────────────────────────────────────

export interface FeatureGateProps {
  /** Entitlement key to check. */
  feature: FeatureKey;
  children: ReactNode;
  /** Rendered when the feature is not entitled. Defaults to null. */
  fallback?: ReactNode;
}

/**
 * Renders `children` when the workspace is entitled to `feature`.
 * Falls back to `fallback ?? null` otherwise.
 * While entitlements are loading or errored the feature is treated as
 * unavailable (fail-closed).
 */
export function FeatureGate({ feature, children, fallback = null }: FeatureGateProps) {
  const { has } = useEntitlements();
  return has(feature) ? <>{children}</> : <>{fallback}</>;
}
