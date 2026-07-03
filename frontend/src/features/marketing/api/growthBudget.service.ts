/**
 * growthBudget.service.ts — typed service layer for the Budget Autopilot
 * (Faz 7). Thin wrappers over `marketingApi` (base `${API_URL}/marketing`);
 * React Query hooks call these instead of inlining axios. Money is in the
 * budget currency's MAJOR unit (e.g. 30000.00 TRY), matching ad insights.
 */

import marketingApi from './marketingApi';

export type BudgetScope = 'HOLISTIC' | 'AD_ONLY';
export type BudgetStatus = 'ACTIVE' | 'PAUSED' | 'KILLED';
export type SpendChannel = 'META' | 'TIKTOK' | 'GOOGLE' | 'LINKEDIN' | 'CONTENT' | 'SMS' | 'VOICE' | 'WHATSAPP';

export interface BudgetAllocation {
  id: string;
  channel: SpendChannel;
  campaignRef: string;
  plannedAmount: string; // Decimal serialized as string
  spentAmount: string;
  marginalRoas: string | null;
  lastPacedAt: string | null;
}

export interface GrowthBudget {
  id: string;
  workspaceId: string;
  periodKey: string; // YYYY-MM
  currency: string;
  totalAmount: string;
  scope: BudgetScope;
  status: BudgetStatus;
  killSwitch: boolean;
  explorationPct: number;
  targetRoas: string | null;
  targetCac: string | null;
  createdAt: string;
  updatedAt: string;
  allocations?: BudgetAllocation[];
}

export interface UpsertBudgetPayload {
  periodKey: string;
  totalAmount: number;
  currency?: string;
  scope?: BudgetScope;
  explorationPct?: number;
  targetRoas?: number;
  targetCac?: number;
}

export interface UpsertAllocationPayload {
  channel: SpendChannel;
  campaignRef?: string;
  plannedAmount: number;
}

export interface ChannelDecision {
  channel: string;
  campaignRef: string;
  before: number;
  after: number;
  deltaPct: number;
  avgRoas: number;
  marginalRoas: number;
  reason: string;
}

export interface ProposeResult {
  runId: string;
  status: 'PROPOSED' | 'SKIPPED';
  reason?: string;
  approvalId?: string;
  plan?: {
    pool: number;
    reserve: number;
    totalBudget: number;
    noop: boolean;
    allocations: ChannelDecision[];
  };
}

export interface AutopilotRun {
  id: string;
  kind: string;
  autonomy: string;
  objective: unknown;
  before: unknown;
  after: unknown;
  ok: boolean;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  kind: string;
  status: string;
  summary: string;
  payload: unknown;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
}

// ── Budgets ───────────────────────────────────────────────────────────────────
export const listGrowthBudgets = () =>
  marketingApi.get<GrowthBudget[]>('/budget').then((r) => r.data);

export const getGrowthBudget = (id: string) =>
  marketingApi.get<GrowthBudget>(`/budget/${id}`).then((r) => r.data);

export const upsertGrowthBudget = (payload: UpsertBudgetPayload) =>
  marketingApi.post<GrowthBudget>('/budget', payload).then((r) => r.data);

export const setBudgetKillSwitch = (id: string, on: boolean) =>
  marketingApi.patch<GrowthBudget>(`/budget/${id}/kill`, { on }).then((r) => r.data);

export const setBudgetStatus = (id: string, status: BudgetStatus) =>
  marketingApi.patch<GrowthBudget>(`/budget/${id}/status`, { status }).then((r) => r.data);

export const upsertAllocation = (id: string, payload: UpsertAllocationPayload) =>
  marketingApi.post<BudgetAllocation>(`/budget/${id}/allocations`, payload).then((r) => r.data);

export const proposeBudget = (id: string) =>
  marketingApi.post<ProposeResult>(`/budget/${id}/propose`).then((r) => r.data);

export const listAutopilotRuns = (id: string) =>
  marketingApi.get<AutopilotRun[]>(`/budget/${id}/runs`).then((r) => r.data);

// ── Approvals ─────────────────────────────────────────────────────────────────
export const listPendingApprovals = () =>
  marketingApi.get<ApprovalRequest[]>('/approvals').then((r) => r.data);

export const approveRequest = (id: string) =>
  marketingApi.post(`/approvals/${id}/approve`).then((r) => r.data);

export const rejectRequest = (id: string) =>
  marketingApi.post(`/approvals/${id}/reject`).then((r) => r.data);
