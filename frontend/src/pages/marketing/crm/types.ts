/**
 * Epic A — CRM config (custom fields · tags · segments) shared types.
 *
 * These mirror the backend DTOs / segment-compiler contract so a payload that
 * passes the frontend always round-trips through the API. Backend remains the
 * source of truth; these exist to type the TanStack Query layer and the forms.
 *
 * Routes (all under `marketingApi` baseURL `${API_URL}/marketing`):
 *   custom fields  GET/POST    /custom-fields            PATCH/DELETE /custom-fields/:id
 *   tags           GET/POST    /tags                     PATCH/DELETE /tags/:id
 *   segments       GET/POST    /segments                 PATCH/DELETE /segments/:id
 *                  POST /segments/preview                POST /segments/:id/count
 */

// ── Custom fields ───────────────────────────────────────────────────────────

export type CustomFieldType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'DATE'
  | 'DATETIME'
  | 'BOOL'
  | 'SELECT'
  | 'MULTISELECT'
  | 'URL'
  | 'PHONE'
  | 'EMAIL';

export interface CustomFieldOption {
  value: string;
  label: string;
}

export interface CustomFieldDef {
  id: string;
  workspaceId: string;
  entity: string; // 'LEAD'
  key: string; // immutable lower_snake_case
  label: string;
  type: CustomFieldType;
  options: CustomFieldOption[] | null;
  required: boolean;
  position: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Tags ────────────────────────────────────────────────────────────────────

export interface MarketingTag {
  id: string;
  workspaceId: string;
  name: string;
  color: string | null;
  createdAt: string;
  /** Member count, added by the list endpoint. */
  count: number;
}

// ── Segments (predicate DSL) ────────────────────────────────────────────────

/** Leaf predicate: `{ field, cmp, value? }`. `value` omitted for isSet/isNotSet. */
export interface SegmentLeaf {
  field: string; // native key | 'tag' | `cf:<key>`
  cmp: string;
  value?: unknown;
}

/** Group node: a boolean combination of children. */
export interface SegmentGroup {
  op: 'and' | 'or';
  children: SegmentNode[];
}

export type SegmentNode = SegmentGroup | SegmentLeaf;

export interface Segment {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  kind: string; // 'DYNAMIC'
  definition: SegmentNode;
  lastCount: number | null;
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentPreviewResult {
  count: number;
  sample: Array<{
    id: string;
    businessName: string | null;
    contactPerson: string | null;
    city: string | null;
    status: string | null;
  }>;
}

export function isSegmentGroup(node: SegmentNode): node is SegmentGroup {
  return !!node && typeof node === 'object' && 'op' in node;
}
