/**
 * custom-objects.service.ts — typed service layer for Custom Objects (GHL
 * parity). A workspace defines its own record types; an object's fields reuse
 * the CustomFieldDef shape (entity = "OBJ:<key>" server-side). Records hold
 * validated values keyed by field key; `displayName` is the primary field's
 * value. Routes are under marketingApi baseURL `${API_URL}/marketing`.
 */

import marketingApi from './marketingApi';
import type { CustomFieldDef, CustomFieldType } from '../../../pages/marketing/crm/types';

export interface CustomObjectDef {
  id: string;
  workspaceId: string;
  key: string;
  labelSingular: string;
  labelPlural: string;
  primaryField: string;
  description: string | null;
  icon: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomObjectRecord {
  id: string;
  workspaceId: string;
  objectDefId: string;
  values: Record<string, unknown>;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordContact {
  linkId: string;
  leadId: string;
  label: string | null;
  contact: { id: string; businessName: string; contactPerson: string; phone: string | null; email: string | null } | null;
}

export interface CreateObjectPayload {
  key: string;
  labelSingular: string;
  labelPlural: string;
  primaryField?: string;
  description?: string;
  icon?: string;
}

export interface CreateFieldPayload {
  label: string;
  key?: string;
  type: CustomFieldType;
  options?: { value: string; label: string }[];
  required?: boolean;
  position?: number;
}

// ── Objects ───────────────────────────────────────────────────────────────────

export const listObjects = (): Promise<CustomObjectDef[]> =>
  marketingApi.get('/custom-objects').then((r) => r.data);

export const getObject = (key: string): Promise<CustomObjectDef> =>
  marketingApi.get(`/custom-objects/${key}`).then((r) => r.data);

export const createObject = (payload: CreateObjectPayload): Promise<CustomObjectDef> =>
  marketingApi.post('/custom-objects', payload).then((r) => r.data);

export const updateObject = (
  key: string,
  payload: Partial<Omit<CreateObjectPayload, 'key'>>,
): Promise<CustomObjectDef> =>
  marketingApi.patch(`/custom-objects/${key}`, payload).then((r) => r.data);

export const archiveObject = (key: string): Promise<CustomObjectDef> =>
  marketingApi.delete(`/custom-objects/${key}`).then((r) => r.data);

// ── Fields ────────────────────────────────────────────────────────────────────

export const listFields = (key: string): Promise<CustomFieldDef[]> =>
  marketingApi.get(`/custom-objects/${key}/fields`).then((r) => r.data);

export const createField = (key: string, payload: CreateFieldPayload): Promise<CustomFieldDef> =>
  marketingApi.post(`/custom-objects/${key}/fields`, payload).then((r) => r.data);

export const updateField = (
  key: string,
  id: string,
  payload: Partial<Pick<CreateFieldPayload, 'label' | 'options' | 'required' | 'position'>>,
): Promise<CustomFieldDef> =>
  marketingApi.patch(`/custom-objects/${key}/fields/${id}`, payload).then((r) => r.data);

export const archiveField = (key: string, id: string): Promise<CustomFieldDef> =>
  marketingApi.delete(`/custom-objects/${key}/fields/${id}`).then((r) => r.data);

// ── Records ───────────────────────────────────────────────────────────────────

export interface RecordPage {
  rows: CustomObjectRecord[];
  total: number;
}

export const listRecords = (
  key: string,
  params: { search?: string; take?: number; skip?: number } = {},
): Promise<RecordPage> =>
  marketingApi.get(`/custom-objects/${key}/records`, { params }).then((r) => r.data);

export const getRecord = (id: string): Promise<CustomObjectRecord & { contacts: RecordContact[] }> =>
  marketingApi.get(`/custom-objects/records/${id}`).then((r) => r.data);

export const createRecord = (key: string, values: Record<string, unknown>): Promise<CustomObjectRecord> =>
  marketingApi.post(`/custom-objects/${key}/records`, { values }).then((r) => r.data);

export const updateRecord = (id: string, values: Record<string, unknown>): Promise<CustomObjectRecord> =>
  marketingApi.patch(`/custom-objects/records/${id}`, { values }).then((r) => r.data);

export const deleteRecord = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/custom-objects/records/${id}`).then((r) => r.data);

// ── Links (record ↔ Contact) ──────────────────────────────────────────────────

export const listRecordContacts = (recordId: string): Promise<RecordContact[]> =>
  marketingApi.get(`/custom-objects/records/${recordId}/contacts`).then((r) => r.data);

export const linkContact = (
  recordId: string,
  payload: { leadId: string; label?: string },
): Promise<unknown> =>
  marketingApi.post(`/custom-objects/records/${recordId}/contacts`, payload).then((r) => r.data);

export const unlinkContact = (recordId: string, linkId: string): Promise<{ message: string }> =>
  marketingApi.delete(`/custom-objects/records/${recordId}/contacts/${linkId}`).then((r) => r.data);

export const listContactRecords = (leadId: string): Promise<
  Array<{ linkId: string; label: string | null; recordId: string; displayName: string; objectKey: string; objectLabel: string }>
> => marketingApi.get(`/custom-objects/contacts/${leadId}/records`).then((r) => r.data);
