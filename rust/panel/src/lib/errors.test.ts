import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { ApiError } from '@/api/client';
import { errorMessage } from './errors';

const t = i18n.t.bind(i18n);

describe('errorMessage', () => {
  it('uses the panel copy for each code, never the server message', () => {
    expect(errorMessage(t, new ApiError('FORBIDDEN', 'forbidden', {}, 403))).toBe(tr.errors.FORBIDDEN);
    expect(errorMessage(t, new ApiError('NETWORK', 'Failed to fetch', {}, 0))).toBe(tr.errors.NETWORK);
    expect(errorMessage(t, new ApiError('SOMETHING_NEW', 'x', {}, 418))).toBe(tr.errors.unknown);
    expect(errorMessage(t, new Error('boom'))).toBe(tr.errors.unknown);
  });

  it('names the invalid field and the known refusal reasons', () => {
    expect(
      errorMessage(t, new ApiError('VALIDATION', 'password must be at least 10 characters', { field: 'password' }, 422)),
    ).toBe('Geçersiz alan: Parola.');
    expect(
      errorMessage(t, new ApiError('CONFLICT', 'cannot demote the last owner', { reason: 'last_owner' }, 409)),
    ).toBe(tr.errors.lastOwner);
    expect(errorMessage(t, new ApiError('FORBIDDEN', 'x', { reason: 'exceeds_own_authority' }, 403))).toBe(
      tr.errors.exceedsAuthority,
    );
  });
});
