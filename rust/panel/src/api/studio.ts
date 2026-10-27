import { request, seg } from './client';
import type { Hypothesis, HypothesisInput, LaneKind, LedgerEntryOut } from './types';
export type Instant = string | number[];
export interface Chain {
  workspace_id: string;
  born_version_id: string;
  hypothesis_id: string;
  arm_id: string;
}
export interface Slot {
  id: string;
  chain: Chain;
  capability_id: string;
  scheduled_at: Instant;
  state: 'planned' | 'ready' | 'published' | 'measured' | 'retired';
  revision: number;
}
export type Target = { slot: string } | { budget_move: string };
export interface Control {
  revision: number;
  brake_engaged: boolean;
  lanes: Partial<Record<LaneKind, { brake_engaged: boolean; requires_human_approval: boolean }>>;
}
export interface Arm {
  id: string;
  key: { hypothesis_id: string; lane: LaneKind; channel: string; content_type: string };
  alpha: number;
  beta: number;
  weight: number;
}
export interface Move {
  id: string;
  chain: Chain;
  binding_id: string;
  revision: number;
  daily_budget_minor: number;
  currency: string;
  state: 'queued' | 'sending' | 'applied' | 'rejected' | 'unknown';
}
export interface Binding {
  id: string;
  chain: Chain;
  capability_id: string;
  account_id: string;
  adset_id: string;
}
export interface Learned {
  arms: {
    arm: Arm;
    evidence: { id: string; status: string; raw_metrics: Record<string, number | null> }[];
  }[];
  hypotheses: { hypothesis_id: string; derived_confidence: number | null }[];
  lane_performance: { lane: LaneKind; reward: number | null; attribution: string | null }[];
  spend_vs_cap: {
    lane: LaneKind;
    currency: string;
    cap_minor: number;
    observed_minor: number | null;
  }[];
  trends: { id: string; hypothesis_id: string; summary: string; source_url: string | null }[];
  judgments: { id: string; hypothesis_id: string; text: string; evidence_ids: string[] }[];
}
export interface Overview {
  strategy: { id: string; number: number };
  goals: { objective: string; kpis: { name: string; target: string }[] };
  hypotheses: Hypothesis[];
  control: Control;
  lane_support: Record<LaneKind, { visible: boolean; supported: boolean; reason: string | null }>;
  slots: Slot[];
  bindings: Binding[];
  learned: Learned;
  today: {
    slots: { slot: Slot; overdue: boolean }[];
    approvals: Target[];
    budget_moves: Move[];
    blockers: { target: Target; reason: string; next_action?: string }[];
    paid_alerts: { binding_id: string; reason: string; residual_provider_exposure: boolean }[];
  };
}
export interface Query {
  hypothesis_id?: string;
  lane?: LaneKind;
  from: string;
  until: string;
}
export interface LedgerQuery extends Query {
  before?: number;
  limit?: number;
}
export interface LedgerPage {
  entries: LedgerEntryOut[];
  next_before: number | null;
}
export type Media =
  | { kind: 'file'; id: string }
  | { kind: 'hosted_url'; url: string; mime: string; size_bytes: number };
export interface SlotDetail {
  slot: Slot;
  piece: { text: string; media: Media[]; adaptations: Record<string, unknown> } | null;
  hypothesis: Hypothesis;
  brand_rules: { identity: { voice: string }; prohibitions: string[] };
  learned: Arm;
  attempts: PublishAttempt[];
  measurements: unknown[];
}
/** A publish attempt as `slot_get` shows it; only what the panel reads is typed. */
export interface PublishAttempt {
  state: 'queued' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'refused';
  /** For a failed, uncertain or refused attempt, the recorded `kind: provider: reason`. */
  failure_reason?: string | null;
}
export interface ExportOut {
  filename: string;
  media_type: string;
  content: string;
}
export interface AdSet {
  id: string;
  name: string;
  status: string;
  daily_budget_minor: number | null;
}
// One wrapper for every business tool. Request keys belong to a user submission, never a retry loop.
export const overview = (q: Query) =>
  request<Overview>('GET', '/api/studio/overview', { query: { ...q } });
export const ledger = (q: LedgerQuery) =>
  request<LedgerPage>('GET', '/api/studio/ledger', { query: { ...q } });
export const ledgerExport = (filter: LedgerQuery) =>
  request<ExportOut>('POST', '/api/studio/ledger/export', { body: { filter } });
export const pending = () => request<Overview['today']>('GET', '/api/studio/pending');
export const slotGet = (id: string) => request<SlotDetail>('GET', `/api/studio/slots/${seg(id)}`);
export const slotCancel = (id: string, expected_revision: number, reason: string) =>
  request<SlotDetail>('POST', `/api/studio/slots/${seg(id)}/cancel`, {
    body: { expected_revision, reason },
  });
export const brake = (engaged: boolean, lane: LaneKind | null, expected_revision: number) =>
  request<Control>('POST', '/api/studio/brake', { body: { engaged, lane, expected_revision } });
export const policySet = (
  lane: LaneKind,
  requires_human_approval: boolean,
  expected_revision: number,
) =>
  request<Control>('PUT', '/api/studio/policy', {
    body: { lane, requires_human_approval, expected_revision },
  });
export const approve = (target: Target, expected_revision: number) =>
  request('POST', '/api/studio/approvals', { body: { target, expected_revision } });
export const hypothesisPropose = (body: HypothesisInput) =>
  request('POST', '/api/studio/hypotheses/proposals', { body });
export const trendRecord = (body: {
  hypothesis_id: string;
  channel: string;
  summary: string;
  source_url?: string;
  observed_at: string;
  request_key: string;
}) => request('POST', '/api/studio/trends', { body });
export const judgmentRecord = (body: {
  hypothesis_id: string;
  evidence_ids: string[];
  text: string;
  request_key: string;
}) => request('POST', '/api/studio/judgments', { body });
export const learned = (q: Query) =>
  request<Learned>('GET', '/api/studio/learned', { query: { ...q } });
export const adsetsList = (capability_id: string) =>
  request<AdSet[]>('GET', '/api/studio/adsets', { query: { capability_id } });
export const adsetBind = (body: {
  hypothesis_id: string;
  arm_id: string;
  capability_id: string;
  adset_id: string;
  request_key: string;
}) => request<Binding>('POST', '/api/studio/adsets/bind', { body });
export const budgetMove = (body: {
  binding_id: string;
  daily_budget_minor: number;
  currency: string;
  request_key: string;
}) => request('POST', '/api/studio/budget-moves', { body });
export const pieceSubmit = (
  id: string,
  body: {
    expected_revision: number;
    request_key: string;
    text: string;
    media: Media[];
    adaptations: Record<string, unknown>;
  },
) => request<SlotDetail>('POST', `/api/studio/slots/${seg(id)}/piece`, { body });
export const fileUpload = (body: {
  filename: string;
  mime: string;
  request_key: string;
  content: { kind: 'bytes_base64'; data: string };
}) => request<{ id: string }>('POST', '/api/studio/files', { body });
/** time's existing domain serde uses [year,ordinal,hour,minute,second,nanos,offsetH,offsetM,offsetS]. */
export function instant(value: Instant): Date {
  if (typeof value === 'string') return new Date(value);
  const [year, day, hour, minute, second, nanos, oh, om, os] = value;
  return new Date(
    Date.UTC(year, 0, day, hour, minute, second, nanos / 1e6) -
      ((oh || 0) * 3600 + (om || 0) * 60 + (os || 0)) * 1000,
  );
}
