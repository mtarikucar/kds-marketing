import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { ApiError } from '@/api/client';
import { callbackErrorMessage, errorMessage, oauthProviderErrorMessage } from './errors';

const t = i18n.t.bind(i18n);

describe('errorMessage', () => {
  it('uses the panel copy for each code, never the server message', () => {
    expect(errorMessage(t, new ApiError('FORBIDDEN', 'forbidden', {}, 403))).toBe(tr.errors.FORBIDDEN);
    expect(errorMessage(t, new ApiError('NETWORK', 'Failed to fetch', {}, 0))).toBe(tr.errors.NETWORK);
    expect(
      errorMessage(t, new ApiError('UPSTREAM_UNAVAILABLE', 'x', { provider: 'meta', retryable: true }, 503)),
    ).toBe(tr.errors.UPSTREAM_UNAVAILABLE);
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
    expect(
      errorMessage(
        t,
        new ApiError(
          'CONFLICT',
          'the draft changed since you read it',
          { version_id: 'v', submitted_at: '2026-10-22T10:00:00Z' },
          409,
        ),
      ),
    ).toBe(tr.errors.draftChanged);
  });

  it('names the connection refusals', () => {
    expect(
      errorMessage(
        t,
        new ApiError(
          'CONFLICT',
          'provider app not configured',
          { reason: 'provider_app_not_configured', provider: 'meta' },
          409,
        ),
      ),
    ).toBe(tr.errors.providerAppMissing);
    expect(
      errorMessage(
        t,
        new ApiError('CONFLICT', 'public base url not configured', { reason: 'public_base_url_not_configured' }, 409),
      ),
    ).toBe(tr.errors.publicUrlMissing);
    expect(
      errorMessage(t, new ApiError('VALIDATION', 'x', { field: 'kind_key', reason: 'use_set_credentials' }, 422)),
    ).toBe(tr.errors.useSetCredentials);
    expect(errorMessage(t, new ApiError('VALIDATION', 'x', { reason: 'account_mismatch' }, 422))).toBe(
      tr.errors.accountMismatch,
    );
    // A provider's refusal: its redacted reason is never shown, even when it reads like one of ours.
    expect(
      errorMessage(
        t,
        new ApiError('VALIDATION', 'x', { provider: 'meta', provider_error: 'auth', reason: 'last_owner' }, 422),
      ),
    ).toBe(tr.errors.providerRefused);
    expect(
      errorMessage(t, new ApiError('CONFLICT', 'x', { kind_key: 'facebook_page', external_id: 'page-1' }, 409)),
    ).toBe(tr.errors.accountTaken);
    expect(
      errorMessage(t, new ApiError('VALIDATION', 'credential.password must not be blank', { field: 'credential.password' }, 422)),
    ).toBe(i18n.t('errors.invalidField', { field: tr.fields.credential.password }));
    expect(errorMessage(t, new ApiError('VALIDATION', 'x', { field: 'selected' }, 422))).toBe(
      i18n.t('errors.invalidField', { field: tr.fields.selected }),
    );
  });

  it("maps a provider's OAuth error and a refused state to the panel's own words", () => {
    expect(oauthProviderErrorMessage(t, 'access_denied')).toBe(tr.oauthCallback.providerDenied);
    expect(oauthProviderErrorMessage(t, '<script>')).toBe(tr.oauthCallback.providerError);
    expect(callbackErrorMessage(t, new ApiError('FORBIDDEN', 'the OAuth state is not valid', {}, 403))).toBe(
      tr.oauthCallback.stateRefused,
    );
    // A missing permission is still named as such.
    expect(
      callbackErrorMessage(t, new ApiError('FORBIDDEN', 'x', { permission: 'capabilities.manage' }, 403)),
    ).toBe(i18n.t('errors.missingPermission', { permission: tr.permissions.capabilities.manage }));
    expect(callbackErrorMessage(t, new ApiError('WORKSPACE_INACTIVE', 'x', { status: 'suspended' }, 423))).toBe(
      tr.errors.WORKSPACE_INACTIVE,
    );
  });

  it("shows a busy provider in the panel's words, never reading its reason as ours", () => {
    expect(
      errorMessage(
        t,
        new ApiError('UPSTREAM_UNAVAILABLE', 'x', { provider: 'meta', retryable: true, reason: 'not_submitted' }, 503),
      ),
    ).toBe(tr.errors.UPSTREAM_UNAVAILABLE);
    expect(
      errorMessage(
        t,
        new ApiError(
          'UPSTREAM_UNAVAILABLE',
          'x',
          { provider: 'x', retryable: true, retry_after_s: 45, reason: 'account_mismatch' },
          503,
        ),
      ),
    ).toBe(i18n.t('errors.upstreamRetryAfter', { seconds: 45 }));
    expect(
      callbackErrorMessage(
        t,
        new ApiError('UPSTREAM_UNAVAILABLE', 'x', { provider: 'meta', retryable: true, reason: 'use_set_credentials' }, 503),
      ),
    ).toBe(tr.errors.UPSTREAM_UNAVAILABLE);
  });
});
