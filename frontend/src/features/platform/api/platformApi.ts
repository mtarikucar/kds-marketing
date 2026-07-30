import axios from 'axios';
import { usePlatformAuthStore } from '../../../store/platformAuthStore';
import { API_URL } from '../../../lib/env';

/**
 * Platform (superadmin) API client. No refresh machinery — the realm uses
 * a 12h access token; a 401 simply drops the operator back to the login
 * screen.
 */
const platformApi = axios.create({
  baseURL: `${API_URL}/platform`,
  headers: { 'Content-Type': 'application/json' },
});

platformApi.interceptors.request.use((config) => {
  const { accessToken } = usePlatformAuthStore.getState();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

platformApi.interceptors.response.use(
  (response) => response,
  (error) => {
    // A 401 from the login endpoint itself means "bad credentials", not an
    // expired session — don't trigger a logout (and let the original error,
    // with the backend message, propagate to the login page).
    const isLogin = (error.config?.url ?? '').includes('/auth/login');
    if (error.response?.status === 401 && !isLogin) {
      usePlatformAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

/**
 * A package as the operator catalog exposes it (`GET /platform/packages`).
 *
 * NOT the same list as the marketing `billing/packages` pricing table: that
 * one is filtered to `isPublic: true`, which hides the internal packages the
 * console exists to grant. `isPublic: false` = internal grant (OPERATOR,
 * TRIAL) — the UI must badge it so an operator never mistakes the unlimited
 * internal package for a customer tier.
 */
export interface PlatformPackage {
  code: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  sortOrder: number;
  trialDays: number;
  prices: {
    monthlyTRY: number;
    monthlyUSD: number;
    yearlyTRY: number | null;
    yearlyUSD: number | null;
  };
  /** Plan quotas + the package `limits` JSON, folded into one map (-1 = unlimited). */
  limits: Record<string, number>;
}

/** Mirrors PackageAssignmentResult from the backend (dates arrive as ISO strings). */
export interface PackageAssignmentResult {
  workspaceId: string;
  packageCode: string;
  packageName: string;
  status: 'ACTIVE';
  /** false = the workspace was already on exactly this grant; nothing was written. */
  changed: boolean;
  currentPeriodEnd: string;
  trialEndsAt: null;
  limits: Record<string, number>;
}

/** Operator package catalog — includes non-public/internal packages. */
export async function listPackages(): Promise<PlatformPackage[]> {
  const { data } = await platformApi.get<PlatformPackage[]>('/packages');
  return data;
}

/**
 * Put a workspace on a package without a payment (internal grant, comped
 * customer, manual bank-transfer rescue). Idempotent: re-assigning the current
 * package returns `changed: false` rather than churning the subscription row.
 *
 * Rejects with the axios error untouched so callers can render the backend
 * message verbatim — a 400 spells out the valid codes, a 404 means the
 * workspace is gone; both are more useful than a generic "failed".
 */
export async function assignPackage(
  workspaceId: string,
  packageCode: string,
): Promise<PackageAssignmentResult> {
  const { data } = await platformApi.patch<PackageAssignmentResult>(
    `/workspaces/${workspaceId}/subscription`,
    { packageCode },
  );
  return data;
}

export default platformApi;
