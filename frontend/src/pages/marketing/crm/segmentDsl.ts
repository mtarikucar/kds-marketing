/**
 * Frontend mirror of the backend SegmentCompilerService whitelist. These tables
 * are the single source of truth for the predicate-builder UI: which native Lead
 * columns can be filtered, what comparators each field type allows, and how the
 * builder rows serialize to the `{ field, cmp, value? }` leaf shape the compiler
 * validates. Keep in lock-step with
 *   backend/src/modules/marketing/services/segment-compiler.service.ts
 */

import type { CustomFieldDef, CustomFieldType, SegmentNode } from './types';
import { isSegmentGroup } from './types';

export type FieldDataType = 'string' | 'number' | 'date' | 'bool';

/** Whitelisted native Lead columns a segment may filter on (key → type). */
export const NATIVE_FIELDS: Record<string, FieldDataType> = {
  status: 'string',
  city: 'string',
  region: 'string',
  source: 'string',
  businessType: 'string',
  priority: 'string',
  businessName: 'string',
  currentSystem: 'string',
  email: 'string',
  phone: 'string',
  aiScore: 'number',
  tableCount: 'number',
  branchCount: 'number',
  createdAt: 'date',
  updatedAt: 'date',
  nextFollowUp: 'date',
  convertedAt: 'date',
  emailOptOut: 'bool',
  smsOptOut: 'bool',
  waOptOut: 'bool',
};

/** Human labels for the native fields (UI only; the wire still uses the key). */
export const NATIVE_FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  city: 'City',
  region: 'Region',
  source: 'Source',
  businessType: 'Business type',
  priority: 'Priority',
  businessName: 'Business name',
  currentSystem: 'Current system',
  email: 'Email',
  phone: 'Phone',
  aiScore: 'AI score',
  tableCount: 'Table count',
  branchCount: 'Branch count',
  createdAt: 'Created at',
  updatedAt: 'Updated at',
  nextFollowUp: 'Next follow-up',
  convertedAt: 'Converted at',
  emailOptOut: 'Email opt-out',
  smsOptOut: 'SMS opt-out',
  waOptOut: 'WhatsApp opt-out',
};

/** Comparators allowed per native field type (matches CMP_BY_TYPE). */
export const CMP_BY_TYPE: Record<FieldDataType, string[]> = {
  string: ['eq', 'ne', 'in', 'nin', 'contains', 'startsWith', 'isSet', 'isNotSet'],
  number: ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'isSet', 'isNotSet'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isSet', 'isNotSet'],
  bool: ['eq', 'ne'],
};

/** Tag membership comparators (field === 'tag'). */
export const TAG_CMP = ['has', 'hasNot'];

/** Comparators allowed on custom-field (`cf:`) leaves. */
export const CF_CMP = ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith'];

/** Comparators that don't take a value. */
export const VALUELESS_CMP = new Set(['isSet', 'isNotSet']);

/** Comparators whose value is a list (comma-separated in the builder). */
export const LIST_CMP = new Set(['in', 'nin']);

/** Comparators with a low/high pair. */
export const RANGE_CMP = new Set(['between']);

export const CMP_LABELS: Record<string, string> = {
  eq: 'is',
  ne: 'is not',
  in: 'is any of',
  nin: 'is none of',
  contains: 'contains',
  startsWith: 'starts with',
  gt: 'greater than',
  gte: 'greater or equal',
  lt: 'less than',
  lte: 'less or equal',
  between: 'between',
  isSet: 'is set',
  isNotSet: 'is not set',
  has: 'has tag',
  hasNot: "doesn't have tag",
};

/** Maps a custom-field declared type to the segment data-type bucket. */
export function cfDataType(type: CustomFieldType): FieldDataType {
  switch (type) {
    case 'NUMBER':
      return 'number';
    case 'DATE':
    case 'DATETIME':
      return 'date';
    case 'BOOL':
      return 'bool';
    default:
      return 'string';
  }
}

export interface FieldChoice {
  /** Wire `field` value: native key, `tag`, or `cf:<key>`. */
  value: string;
  label: string;
  group: 'lead' | 'custom' | 'tag';
  dataType: FieldDataType;
  /** For SELECT/MULTISELECT custom fields: the enumerated options. */
  options?: { value: string; label: string }[];
}

/** Build the field picker choices from the native whitelist + workspace CF defs. */
export function buildFieldChoices(defs: CustomFieldDef[]): FieldChoice[] {
  const native: FieldChoice[] = Object.entries(NATIVE_FIELDS).map(([value, dataType]) => ({
    value,
    label: NATIVE_FIELD_LABELS[value] ?? value,
    group: 'lead',
    dataType,
  }));
  const tag: FieldChoice = { value: 'tag', label: 'Tag', group: 'tag', dataType: 'string' };
  const custom: FieldChoice[] = defs
    .filter((d) => !d.archived)
    .map((d) => ({
      value: `cf:${d.key}`,
      label: d.label,
      group: 'custom',
      dataType: cfDataType(d.type),
      options:
        d.type === 'SELECT' || d.type === 'MULTISELECT'
          ? (d.options ?? []).map((o) => ({ value: o.value, label: o.label }))
          : undefined,
    }));
  return [...native, tag, ...custom];
}

/**
 * Reshape a leaf value when its comparator changes, so the serialized value
 * matches what the new comparator expects. `in`/`nin`/`between` take a list
 * (array); every other (scalar) comparator takes a single value. Switching
 * across that boundary must DROP the stale value — otherwise the builder would
 * serialize e.g. an array under a scalar `eq` (the compiler rejects it / it 500s
 * on evaluation) or a string under `in` (compiles to an empty match). Keep the
 * value only when the list-vs-scalar shape is unchanged. (VALUELESS comparators
 * — isSet/isNotSet — are handled by the caller, which strips the value.)
 */
export function reshapeValueForCmp(cmp: string, current: unknown): unknown {
  const wantsList = LIST_CMP.has(cmp) || RANGE_CMP.has(cmp);
  const hasList = Array.isArray(current);
  if (wantsList === hasList) return current ?? '';
  return wantsList ? [] : '';
}

/** Comparators valid for a given field choice. */
export function comparatorsFor(choice: FieldChoice | undefined): string[] {
  if (!choice) return [];
  if (choice.group === 'tag') return TAG_CMP;
  if (choice.group === 'custom') return CF_CMP;
  return CMP_BY_TYPE[choice.dataType];
}

/** Count leaves + groups (used to enforce the backend MAX_NODES = 100 ceiling). */
export function countNodes(node: SegmentNode): number {
  if (isSegmentGroup(node)) {
    return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
  }
  return 1;
}

export const MAX_NODES = 100;
export const MAX_DEPTH = 6;
