import type { TFunction } from 'i18next';
import { isApiError } from '@/api/client';

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
] as const;
type FieldName = (typeof FIELDS)[number];

function isCode(code: string): code is Code {
  return (CODES as readonly string[]).includes(code);
}

function isField(field: unknown): field is FieldName {
  return typeof field === 'string' && (FIELDS as readonly string[]).includes(field);
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
    default:
      break;
  }
  if (err.code === 'VALIDATION' && isField(err.details.field)) {
    return t('errors.invalidField', { field: t(`fields.${err.details.field}`) });
  }
  return isCode(err.code) ? t(`errors.${err.code}`) : t('errors.unknown');
}
