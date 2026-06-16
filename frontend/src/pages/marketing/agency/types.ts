/**
 * Epic D — Agency console (sub-accounts · snapshots · rebilling) shared types.
 *
 * These mirror the backend Prisma shapes / DTO contracts so a payload that
 * passes the frontend round-trips through the API. The backend is the source of
 * truth (agency.controller.ts / snapshot.controller.ts / rebilling.controller.ts);
 * every route is AGENCY-OWNER gated server-side. The whole console is also hidden
 * client-side unless `workspace.kind === 'AGENCY'`.
 *
 * Routes (all under `marketingApi` baseURL `${API_URL}/marketing`):
 *   locations   GET  /agency/locations              POST /agency/locations
 *               GET  /agency/locations/:id          PATCH /agency/locations/:id/suspend
 *               GET  /agency/dashboard
 *   snapshots   GET/POST /agency/snapshots          GET  /agency/snapshots/:id
 *               POST /agency/snapshots/:id/apply/:locationId
 *   rebilling   GET  /agency/rebilling/plans        GET/PUT /agency/rebilling/plans/:locationId
 *               GET  /agency/rebilling/charges
 *               POST /agency/rebilling/charges/:locationId/compute
 *               POST /agency/rebilling/charges/:chargeId/charge
 */

export type WorkspaceStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | string;

/** A child LOCATION sub-account (the PUBLIC_WORKSPACE_FIELDS the service returns). */
export interface Location {
  id: string;
  slug: string;
  name: string;
  status: WorkspaceStatus;
  kind: string;
  parentWorkspaceId: string | null;
  productName: string;
  productUrl: string | null;
  defaultLanguage?: string;
  defaultCurrency?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
}

/** One row of the agency dashboard summary (per-location counts). */
export interface DashboardLocation {
  id: string;
  slug: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  leadCount: number;
  userCount: number;
}

export interface AgencyDashboard {
  agencyWorkspaceId: string;
  locationCount: number;
  activeLocationCount: number;
  totalLeads: number;
  locations: DashboardLocation[];
}

// ── Snapshots ───────────────────────────────────────────────────────────────

/** A snapshot list row (the service's list select). */
export interface SnapshotListItem {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

/** The config types a snapshot captures, in apply order (mirror of the backend). */
export const SNAPSHOT_CONFIG_TYPES = [
  'customFieldDefs',
  'tags',
  'segments',
  'workflows',
  'agentProfiles',
  'sitePages',
  'formDefs',
  'bookingCalendars',
  'knowledgeDocs',
  'reviewSources',
] as const;

export type SnapshotConfigType = (typeof SNAPSHOT_CONFIG_TYPES)[number];

export interface ApplyTypeSummary {
  created: number;
  skipped: number;
}

export type ApplySummary = Record<SnapshotConfigType, ApplyTypeSummary>;

export interface ApplyResult {
  snapshotId: string;
  targetWorkspaceId: string;
  summary: ApplySummary;
}

// ── Rebilling ───────────────────────────────────────────────────────────────

/** Per-location rebilling plan. Money fields are Decimal strings off the wire. */
export interface RebillingPlan {
  id: string;
  workspaceId: string;
  locationWorkspaceId: string;
  basePrice: string;
  usageUnitPrice: string;
  markupPercent: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RebillChargeStatus = 'DRAFT' | 'INVOICED' | 'PAID' | 'FAILED' | string;

/** A settlement line produced by computeCharge / settled via Stripe Connect. */
export interface RebillCharge {
  id: string;
  workspaceId: string;
  locationWorkspaceId: string;
  periodStart: string;
  periodEnd: string;
  baseAmount: string;
  usageAmount: string;
  totalAmount: string;
  usageUnits: number;
  status: RebillChargeStatus;
  stripeChargeId: string | null;
  createdAt: string;
}
