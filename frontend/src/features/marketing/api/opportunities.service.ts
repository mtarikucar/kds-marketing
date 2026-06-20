/**
 * opportunities.service.ts — typed service layer for Sales Opportunities +
 * Pipelines (GoHighLevel parity). Thin, typed wrappers over `marketingApi`;
 * React Query hooks call these instead of inlining axios. Mirrors the
 * convention documented for leads.service.ts.
 */

import marketingApi from './marketingApi';
import type { PaginatedResponse } from '../types';

// ── Domain types ─────────────────────────────────────────────────────────────

export interface PipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  position: number;
  isDefault: boolean;
  archived: boolean;
  stages: PipelineStage[];
}

export type OpportunityStatus = 'OPEN' | 'WON' | 'LOST' | 'ABANDONED';

export interface Opportunity {
  id: string;
  pipelineId: string;
  stageId: string;
  leadId: string | null;
  assignedToId: string | null;
  name: string;
  value: string | number;
  currency: string;
  status: OpportunityStatus;
  source: string | null;
  notes: string | null;
  position: number;
  lostReason: string | null;
  wonAt: string | null;
  lostAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardStage extends PipelineStage {
  opportunities: Opportunity[];
  totalValue: number;
  count: number;
}

export interface Board {
  pipeline: { id: string; name: string; isDefault: boolean };
  stages: BoardStage[];
}

// ── Payload types ────────────────────────────────────────────────────────────

export interface StageInput {
  name: string;
  position?: number;
  probability?: number;
  isWon?: boolean;
  isLost?: boolean;
}

export interface CreatePipelinePayload {
  name: string;
  isDefault?: boolean;
  stages?: StageInput[];
}

export interface UpdatePipelinePayload {
  name?: string;
  position?: number;
  isDefault?: boolean;
  archived?: boolean;
}

export interface CreateOpportunityPayload {
  name: string;
  pipelineId?: string;
  stageId?: string;
  leadId?: string;
  assignedToId?: string;
  value?: number;
  currency?: string;
  source?: string;
  notes?: string;
}

export interface UpdateOpportunityPayload {
  name?: string;
  value?: number;
  currency?: string;
  source?: string;
  notes?: string;
  assignedToId?: string;
  leadId?: string;
}

export interface OpportunityListParams {
  pipelineId?: string;
  stageId?: string;
  status?: string;
  assignedToId?: string;
  leadId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

// ── Pipelines ────────────────────────────────────────────────────────────────

export const listPipelines = (): Promise<Pipeline[]> =>
  marketingApi.get('/pipelines').then((r) => r.data);

export const createPipeline = (payload: CreatePipelinePayload): Promise<Pipeline> =>
  marketingApi.post('/pipelines', payload).then((r) => r.data);

export const updatePipeline = (id: string, payload: UpdatePipelinePayload): Promise<Pipeline> =>
  marketingApi.patch(`/pipelines/${id}`, payload).then((r) => r.data);

export const deletePipeline = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/pipelines/${id}`).then((r) => r.data);

export const addStage = (pipelineId: string, payload: StageInput): Promise<PipelineStage> =>
  marketingApi.post(`/pipelines/${pipelineId}/stages`, payload).then((r) => r.data);

export const updateStage = (
  pipelineId: string,
  stageId: string,
  payload: Partial<StageInput>,
): Promise<PipelineStage> =>
  marketingApi.patch(`/pipelines/${pipelineId}/stages/${stageId}`, payload).then((r) => r.data);

export const deleteStage = (
  pipelineId: string,
  stageId: string,
): Promise<{ message: string }> =>
  marketingApi.delete(`/pipelines/${pipelineId}/stages/${stageId}`).then((r) => r.data);

export const reorderStages = (pipelineId: string, stageIds: string[]): Promise<Pipeline> =>
  marketingApi.put(`/pipelines/${pipelineId}/stages/reorder`, { stageIds }).then((r) => r.data);

// ── Opportunities ────────────────────────────────────────────────────────────

export const getBoard = (pipelineId?: string): Promise<Board> =>
  marketingApi
    .get('/opportunities/board', { params: pipelineId ? { pipelineId } : {} })
    .then((r) => r.data);

export const listOpportunities = (
  params: OpportunityListParams = {},
): Promise<PaginatedResponse<Opportunity>> =>
  marketingApi.get('/opportunities', { params }).then((r) => r.data);

export const getOpportunity = (id: string): Promise<Opportunity> =>
  marketingApi.get(`/opportunities/${id}`).then((r) => r.data);

export const createOpportunity = (payload: CreateOpportunityPayload): Promise<Opportunity> =>
  marketingApi.post('/opportunities', payload).then((r) => r.data);

export const updateOpportunity = (
  id: string,
  payload: UpdateOpportunityPayload,
): Promise<Opportunity> =>
  marketingApi.patch(`/opportunities/${id}`, payload).then((r) => r.data);

export const moveOpportunity = (
  id: string,
  stageId: string,
  position?: number,
): Promise<Opportunity> =>
  marketingApi.post(`/opportunities/${id}/move`, { stageId, position }).then((r) => r.data);

export const winOpportunity = (id: string): Promise<Opportunity> =>
  marketingApi.post(`/opportunities/${id}/win`).then((r) => r.data);

export const loseOpportunity = (id: string, reason?: string): Promise<Opportunity> =>
  marketingApi.post(`/opportunities/${id}/lost`, { reason }).then((r) => r.data);

export const deleteOpportunity = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/opportunities/${id}`).then((r) => r.data);
