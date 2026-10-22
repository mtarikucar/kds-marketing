import type { TFunction } from 'i18next';
import { isApiError } from '@/api/client';
import { PERMISSIONS, type Gap, type Permission } from '@/api/types';

// Server messages are English and meant for logs and agents; the panel shows its own copy for
// each structured error code, sharpened by `details` where the server gives a reason or field.

const CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION',
  'STRATEGY_REQUIRED',
  'WORKSPACE_INACTIVE',
  'HOST_NOT_ALLOWED',
  'INTERNAL',
  'NETWORK',
] as const;
type Code = (typeof CODES)[number];

const FIELDS = [
  'email',
  'password',
  'display_name',
  'workspace_name',
  'key',
  'name',
  'role_key',
  'permissions',
  'scopes',
  'token',
  'status',
  'actor_kind',
  'kind_key',
  'key_detail',
  'description',
  'external_id',
  'connector_public',
  'policy',
  'minutes',
  'unit',
  'cap',
  'amount',
  'reference',
  'reason',
  'text',
  'section_key',
  'version_id',
  'evidence',
  'purpose',
  'capability_id',
  'budget_item_id',
  'kind',
  'period',
  'limit',
  'before_at',
  'before_id',
  'group',
  'group_id',
  'confirm',
] as const;
type FieldName = (typeof FIELDS)[number];

function isCode(code: string): code is Code {
  return (CODES as readonly string[]).includes(code);
}

function isField(field: unknown): field is FieldName {
  return typeof field === 'string' && (FIELDS as readonly string[]).includes(field);
}

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

function isGap(value: unknown): value is Gap {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.field === 'string' && typeof v.message === 'string';
}

/** The gaps a `VALIDATION` refusal lists in `details.gaps` (empty for any other failure). */
export function gapsOf(err: unknown): Gap[] {
  if (!isApiError(err)) return [];
  const gaps = err.details.gaps;
  return Array.isArray(gaps) ? gaps.filter(isGap) : [];
}

/** The panel's text for a failed request (or any other thrown value). */
export function errorMessage(t: TFunction, err: unknown): string {
  if (!isApiError(err)) return t('errors.unknown');
  switch (err.details.reason) {
    case 'last_owner':
      return t('errors.lastOwner');
    case 'owner_only':
      return t('errors.ownerOnly');
    case 'exceeds_own_authority':
      return t('errors.exceedsAuthority');
    case 'owner_or_manager':
      return t('errors.ownerOrManager');
    case 'unit_mismatch':
      return t('errors.unitMismatch');
    case 'kind_mismatch':
      return t('errors.kindMismatch');
    case 'name_taken':
      return t('errors.nameTaken');
    case 'not_submitted':
      return t('errors.notSubmitted');
    case 'another_approval_won':
      return t('errors.anotherApprovalWon');
    case 'no_approved_version':
      return t('errors.noApprovedVersion');
    case 'no_draft':
      return t('errors.noDraft');
    case 'version_moved':
      return t('errors.versionMoved');
    default:
      break;
  }
  // `strategy.approve` names the draft as it now stands when it changed since it was shown.
  if (err.code === 'CONFLICT' && 'submitted_at' in err.details && 'version_id' in err.details) {
    return t('errors.draftChanged');
  }
  if (err.code === 'FORBIDDEN' && isPermission(err.details.permission)) {
    return t('errors.missingPermission', { permission: t(`permissions.${err.details.permission}`) });
  }
  if (err.code === 'VALIDATION' && isField(err.details.field)) {
    return t('errors.invalidField', { field: t(`fields.${err.details.field}`) });
  }
  return isCode(err.code) ? t(`errors.${err.code}`) : t('errors.unknown');
}
