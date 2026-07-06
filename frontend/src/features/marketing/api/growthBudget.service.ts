/**
 * growthBudget.service.ts — typed service layer for the Budget Autopilot
 * (Faz 7). Thin wrappers over `marketingApi` (base `${API_URL}/marketing`);
 * React Query hooks call these instead of inlining axios. Money is in the
 * budget currency's MAJOR unit (e.g. 30000.00 TRY), matching ad insights.
 */

import marketingApi from './marketingApi';

export type BudgetScope = 'HOLISTIC' | 'AD_ONLY';
export type AllocatorStage = 'MARGINAL' | 'BANDIT' | 'MMM';
export type BudgetStatus = 'ACTIVE' | 'PAUSED' | 'KILLED';
export type AutonomyLevel = 'SHADOW' | 'ASSISTED' | 'AUTONOMOUS';
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
  allocatorStage: AllocatorStage;
  /** Autonomy lane (spec D6). Existing rows default to ASSISTED. */
  autonomyLevel: AutonomyLevel;
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
  allocatorStage?: AllocatorStage;
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

export interface ApplyReallocationResult {
  status: 'APPLIED' | 'NO_LIVE_WRITE' | 'ALREADY_APPLIED';
  runId?: string;
  applied: number;
  skipped: number;
}

/** Apply an APPROVED budget reallocation: commit it to the plan + push live to
 *  any write-capable ad platform (Meta, cred-gated). */
export const applyReallocation = (approvalId: string) =>
  marketingApi
    .post<ApplyReallocationResult>(`/budget/reallocations/${approvalId}/apply`)
    .then((r) => r.data);

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

// ── Growth Autopilot (wallet + autonomy + activity, spec D12/D14) ─────────────

/** Growth-credit wallet snapshot. `balance` is a Decimal serialized as string. */
export interface GrowthWalletState {
  workspaceId: string;
  balance: string;
  currency: string;
  /** False = zero-balance shell (never topped up). */
  exists: boolean;
}

export type ActivityType = 'RUN' | 'SPEND' | 'WALLET';

/** One Activity Log entry — the client localizes the plain-language "why". */
export interface ActivityItem {
  ts: string;
  type: ActivityType;
  data: Record<string, unknown>;
}

export interface QuickStartPayload {
  /** Monthly cap (major units). Defaults server-side to the wallet balance. */
  amount?: number;
  targetRoas?: number;
  targetCac?: number;
  /** Arm the AUTONOMOUS lane (env-flag-gated; the user's ONE opt-in). */
  arm?: boolean;
}

/** Everything one quick-start call provisioned — the wizard renders this. */
export interface ContentCampaignSummary {
  campaignIds: string[];
  count: number;
}

export interface QuickStartManifest {
  wallet: { balance: string; currency: string; exists: boolean };
  budget: { id: string; periodKey: string; totalAmount: string; autonomyLevel: string; status: string };
  channels: string[];
  allocations: Array<{ channel: string; plannedAmount: string }>;
  armed: boolean;
  /** The autonomous content campaigns the same click set up, or null when it didn't run. */
  contentCampaign: ContentCampaignSummary | null;
}

/** What the SPA does after a top-up checkout: iframe (PayTR), redirect (Stripe), or bank instructions. */
export type CheckoutHandle =
  | { kind: 'iframe'; token: string; iframeUrl: string }
  | { kind: 'redirect'; url: string }
  | {
      kind: 'bank_transfer';
      instructions: { iban: string; accountName: string; amountFormatted: string; reference: string };
    };

export interface WalletTopupPayload {
  amount: number;
  provider: 'paytr' | 'stripe' | 'manual';
  currency?: string;
}

export const getWalletState = () =>
  marketingApi.get<GrowthWalletState>('/budget/wallet').then((r) => r.data);

export const quickStart = (payload: QuickStartPayload) =>
  marketingApi.post<QuickStartManifest>('/budget/quick-start', payload).then((r) => r.data);

export const listBudgetActivity = (id: string) =>
  marketingApi.get<ActivityItem[]>(`/budget/${id}/activity`).then((r) => r.data);

export const setAutonomyLevel = (id: string, level: AutonomyLevel) =>
  marketingApi.patch<GrowthBudget>(`/budget/${id}/autonomy`, { level }).then((r) => r.data);

export const walletTopup = (payload: WalletTopupPayload) =>
  marketingApi
    .post<{ orderId: string; handle: CheckoutHandle }>('/billing/wallet-topup', payload)
    .then((r) => r.data);

// ── Approvals ─────────────────────────────────────────────────────────────────
export const listPendingApprovals = () =>
  marketingApi.get<ApprovalRequest[]>('/approvals').then((r) => r.data);

export const approveRequest = (id: string) =>
  marketingApi.post(`/approvals/${id}/approve`).then((r) => r.data);

export const rejectRequest = (id: string) =>
  marketingApi.post(`/approvals/${id}/reject`).then((r) => r.data);
