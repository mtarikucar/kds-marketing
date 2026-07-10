/**
 * leads.service.ts — Typed service layer for the leads feature.
 *
 * Reference implementation of the typed-API-service convention (see
 * docs/superpowers/adr/2026-06-15-frontend-api-service-layer.md).
 *
 * Every function is a thin wrapper around `marketingApi` that adds:
 *  - An explicit return type anchored to the domain types in `types.ts`
 *  - A named, documented home for every endpoint used by the leads feature
 *
 * React Query hooks call these functions instead of inlining axios calls.
 * Query keys, params, payloads, and invalidation patterns are NOT changed —
 * the service only centralises and types the HTTP layer.
 */

import marketingApi from './marketingApi';
import type { Lead, PaginatedResponse, LeadActivity } from '../types';
import type { DetailLead } from '../../../pages/marketing/leadDetail/types';

// ── Query-param types ────────────────────────────────────────────────────────

export interface LeadListParams {
  search?: string;
  status?: string;
  source?: string;
  businessType?: string;
  assignmentStatus?: string;
  // Server-side sort. sortBy must be one of the backend allow-listed columns
  // (createdAt, updatedAt, businessName, contactPerson, city, status, source,
  // priority, nextFollowUp); anything else falls back to createdAt desc.
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// Activity create payload — mirrors what LeadDetailPage passes to
// activityMutation.
export interface CreateActivityPayload {
  type: string;
  title: string;
  description?: string;
}

// Offer create payload — untyped in the original page (any), kept permissive
// here so existing callers don't need to change.
export type CreateOfferPayload = Record<string, unknown>;

// Task create payload — same as above.
export type CreateTaskPayload = Record<string, unknown>;

// Upsert (create or patch) payload — the pre-processed shape built in
// CreateLeadPage.onSubmit before calling mutate().
export type UpsertLeadPayload = Record<string, unknown>;

// Convert payload — MUST mirror the backend ConvertLeadDto EXACTLY. The global
// ValidationPipe runs with forbidNonWhitelisted, so any extra property (e.g. a
// stray adminPassword/commissionAmount) makes /convert 400. A concrete type —
// not Record<string, unknown> — makes that contract a compile-time error.
export interface ConvertLeadPayload {
  tenantName: string;
  adminEmail: string;
  adminFirstName: string;
  adminLastName: string;
  planId?: string;
  offerId?: string;
}

// ── Service functions ────────────────────────────────────────────────────────

/** GET /leads — paginated list with optional filters. */
export function listLeads(params: LeadListParams): Promise<PaginatedResponse<Lead>> {
  return marketingApi
    .get<PaginatedResponse<Lead>>('/leads', { params })
    .then((r) => r.data);
}

/** GET /leads/:id — single lead with eagerly-loaded relations (activities, offers, tasks). */
export function getLead(id: string): Promise<DetailLead> {
  return marketingApi.get<DetailLead>(`/leads/${id}`).then((r) => r.data);
}

/**
 * POST /leads or PATCH /leads/:id — create or update.
 *
 * When `id` is provided the call is a PATCH (edit mode); when omitted it is a
 * POST (create). The returned object is the saved lead.
 */
export function upsertLead(payload: UpsertLeadPayload, id?: string): Promise<Lead> {
  return id
    ? marketingApi.patch<Lead>(`/leads/${id}`, payload).then((r) => r.data)
    : marketingApi.post<Lead>('/leads', payload).then((r) => r.data);
}

/** PATCH /leads/:id/status — update lead status field only. */
export function updateLeadStatus(id: string, status: string): Promise<void> {
  return marketingApi.patch(`/leads/${id}/status`, { status }).then(() => undefined);
}

/** PATCH /leads/:id — link/unlink the contact's B2B company ('' unlinks). */
export function setLeadCompany(id: string, companyId: string): Promise<Lead> {
  return marketingApi.patch<Lead>(`/leads/${id}`, { companyId }).then((r) => r.data);
}

/** POST /leads/:id/convert — mark lead as won and provision tenant. */
export function convertLead(id: string, data: ConvertLeadPayload): Promise<void> {
  return marketingApi.post(`/leads/${id}/convert`, data).then(() => undefined);
}

/** DELETE /leads/:id. */
export function deleteLead(id: string): Promise<void> {
  return marketingApi.delete(`/leads/${id}`).then(() => undefined);
}

/** POST /leads/:id/verify-phone/start — NetGSM SMS v2 Task 12 (behind the
 *  `smsOtp` add-on). Texts a fresh code to the lead's phone on file. */
export function verifyLeadPhoneStart(id: string): Promise<{ sent: boolean }> {
  return marketingApi.post(`/leads/${id}/verify-phone/start`).then((r) => r.data);
}

/** POST /leads/:id/verify-phone/confirm — verifies the code and stamps
 *  `lead.phoneVerifiedAt` on success. */
export function verifyLeadPhoneConfirm(id: string, code: string): Promise<{ phoneVerifiedAt: string }> {
  return marketingApi.post(`/leads/${id}/verify-phone/confirm`, { code }).then((r) => r.data);
}

/** POST /leads/:id/activities — log an activity against a lead. */
export function createLeadActivity(
  leadId: string,
  data: CreateActivityPayload,
): Promise<LeadActivity> {
  return marketingApi.post<LeadActivity>(`/leads/${leadId}/activities`, data).then((r) => r.data);
}

/** POST /offers — create an offer linked to a lead. */
export function createOffer(data: CreateOfferPayload): Promise<void> {
  return marketingApi.post('/offers', data).then(() => undefined);
}

/** POST /offers/:offerId/send — mark an offer as sent. */
export function sendOffer(offerId: string): Promise<void> {
  return marketingApi.post(`/offers/${offerId}/send`).then(() => undefined);
}

/** DELETE /offers/:offerId. */
export function deleteOffer(offerId: string): Promise<void> {
  return marketingApi.delete(`/offers/${offerId}`).then(() => undefined);
}

/** POST /tasks — create a task linked to a lead. */
export function createTask(data: CreateTaskPayload): Promise<void> {
  return marketingApi.post('/tasks', data).then(() => undefined);
}

/** PATCH /tasks/:taskId/complete — mark a task done. */
export function completeTask(taskId: string): Promise<void> {
  return marketingApi.patch(`/tasks/${taskId}/complete`).then(() => undefined);
}

/** DELETE /tasks/:taskId. */
export function deleteTask(taskId: string): Promise<void> {
  return marketingApi.delete(`/tasks/${taskId}`).then(() => undefined);
}

/** POST /leads/bulk-assign — assign (or unassign) many leads at once. `unchanged`
 *  were already assigned to that rep (no-op); `skipped` are ids not found in the
 *  workspace (e.g. deleted between selection and submit). */
export function bulkAssignLeads(
  leadIds: string[],
  assignedToId: string | null,
): Promise<{ assigned: number; skipped: string[]; unchanged: number }> {
  return marketingApi
    .post<{ assigned: number; skipped: string[]; unchanged: number }>('/leads/bulk-assign', {
      leadIds,
      assignedToId,
    })
    .then((r) => r.data);
}

/** POST /leads/bulk-delete — soft-delete many leads at once. `skippedProtected`
 *  is how many were refused (WON / converted-tenant leads can't be deleted). */
export function bulkDeleteLeads(
  leadIds: string[],
): Promise<{ deleted: number; skippedProtected: number }> {
  return marketingApi
    .post<{ deleted: number; skippedProtected: number }>('/leads/bulk-delete', { leadIds })
    .then((r) => r.data);
}

/** POST /leads/bulk-enroll — queue a background enroll of many leads into a workflow. */
export function bulkEnrollLeads(
  leadIds: string[],
  workflowId: string,
): Promise<{ queued: number }> {
  return marketingApi
    .post<{ queued: number }>('/leads/bulk-enroll', { leadIds, workflowId })
    .then((r) => r.data);
}

/** GET /leads/export.csv — download the filtered lead list as a CSV file. */
export async function exportLeadsCsv(params: LeadListParams): Promise<void> {
  const res = await marketingApi.get('/leads/export.csv', { params, responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
