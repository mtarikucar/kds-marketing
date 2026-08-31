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
  expectedCloseDate: string | null;
  wonAt: string | null;
  lostAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A person, as the board and the "Hatta değil" column both show them.
 *
 * ONE shape for both surfaces on purpose. `name` is computed SERVER-side
 * (`contactPerson || businessName`, trimmed) by the same rule PeopleList and
 * PersonPane apply, so a board card and the person list cannot disagree about
 * what someone is called. Use it; do not re-derive it here.
 *
 * `name` is never null but MAY be empty — a lead with neither field set is
 * legal — so a renderer still has to decide what an unnamed person looks like.
 * `status` is the LEAD's lifecycle status (NEW, CONTACTED, …), not the deal's.
 */
export interface PersonCard {
  id: string;
  name: string;
  businessName: string | null;
  contactPerson: string | null;
  phone: string | null;
  status: string;
  assignedToId: string | null;
  /** ISO 8601 of the newest message on any of their threads; null if none. */
  lastMessageAt: string | null;
}

/**
 * A board card. `lead` is null when the deal has no `leadId`, or when the id it
 * carries does not resolve INSIDE this workspace — `Opportunity.leadId` is a
 * bare string with no foreign key, so it may name a deleted person or a
 * neighbour's. The id stays on the row either way; only the name is withheld.
 */
export interface BoardOpportunity extends Opportunity {
  lead: PersonCard | null;
}

export interface BoardStage extends PipelineStage {
  opportunities: BoardOpportunity[];
  totalValue: number;
  weightedValue: number;
  count: number;
}

export interface Board {
  pipeline: { id: string; name: string; isDefault: boolean };
  stages: BoardStage[];
}

// ── Forecast ─────────────────────────────────────────────────────────────────

export interface ForecastStage {
  stageId: string;
  name: string;
  probability: number;
  count: number;
  rawValue: number;
  weightedValue: number;
}

export interface ForecastMonth {
  month: string; // 'YYYY-MM' or 'unscheduled'
  rawValue: number;
  count: number;
}

export interface Forecast {
  pipeline: { id: string; name: string };
  currencies: string[];
  stages: ForecastStage[];
  rawTotal: number;
  weightedTotal: number;
  openCount: number;
  months: ForecastMonth[];
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
  /**
   * Optional ONLY when `leadId` is given — mirrors `CreateOpportunityDto`. That
   * is the drag-a-PERSON-onto-a-stage path, and the record card's "Hatta ekle":
   * the gesture supplies no deal name, so the backend falls back to the
   * person's own `contactPerson || businessName`. Inventing a name client-side
   * instead would put a second answer to "what is this person called" on the
   * wire, next to the one `PersonCard.name` already computes server-side.
   *
   * A deal with neither a name nor a person is still refused — by the service,
   * where the lead has been read and the fallback actually exists.
   */
  name?: string;
  pipelineId?: string;
  stageId?: string;
  leadId?: string;
  assignedToId?: string;
  value?: number;
  currency?: string;
  source?: string;
  notes?: string;
  expectedCloseDate?: string;
}

export interface UpdateOpportunityPayload {
  name?: string;
  value?: number;
  currency?: string;
  source?: string;
  notes?: string;
  assignedToId?: string;
  leadId?: string;
  expectedCloseDate?: string | null;
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

/**
 * The people with NO open deal — the board's leftmost column.
 *
 * Paginated because there are 361 of them on the live workspace and 361 cards
 * are not one screen. `meta.total` is the WHOLE column on every page, so a
 * header can honestly read "361" while twenty cards are drawn.
 *
 * Not scoped to a pipeline: "in the pipeline" is `status = 'OPEN'` on ANY deal,
 * so switching the board's pipeline selector does not change who is outside.
 */
export const listNotInPipeline = (
  params: { page?: number; limit?: number; search?: string } = {},
): Promise<PaginatedResponse<PersonCard>> =>
  marketingApi.get('/opportunities/not-in-pipeline', { params }).then((r) => r.data);

export const getForecast = (pipelineId?: string): Promise<Forecast> =>
  marketingApi
    .get('/opportunities/forecast', { params: pipelineId ? { pipelineId } : {} })
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
