import { describe, it, expect } from 'vitest';
import { loginErrorMessage } from './authError';

// t() echoes the key so we can assert which message was chosen.
const t = (k: string) => k;

describe('loginErrorMessage', () => {
  it('maps a 401 wrong-password (backend "Invalid credentials") to login.wrongCreds', () => {
    const err = { response: { status: 401, data: { message: 'Invalid credentials' } } };
    expect(loginErrorMessage(err, t)).toBe('login.wrongCreds');
  });

  it('maps a 401 locked account to login.lockedTryLater', () => {
    const err = { response: { status: 401, data: { message: 'Account is temporarily locked' } } };
    expect(loginErrorMessage(err, t)).toBe('login.lockedTryLater');
  });

  it('maps a 401 inactive account to login.inactive', () => {
    const err = { response: { status: 401, data: { message: 'Account is inactive' } } };
    expect(loginErrorMessage(err, t)).toBe('login.inactive');
  });

  it('falls back to login.wrongCreds for a 401 with no message', () => {
    const err = { response: { status: 401, data: {} } };
    expect(loginErrorMessage(err, t)).toBe('login.wrongCreds');
  });

  it('uses login.networkError when there is no HTTP response (the old "no refresh token" path)', () => {
    // Regression: before the interceptor fix, a wrong password surfaced a bare
    // Error('no refresh token') with no `.response`. It must never be shown raw.
    const err = { message: 'no refresh token' };
    expect(loginErrorMessage(err, t)).toBe('login.networkError');
    expect(loginErrorMessage(err, t)).not.toBe('no refresh token');
  });

  it('prefers the backend message for non-401 statuses, else login.failed', () => {
    expect(loginErrorMessage({ response: { status: 409, data: { message: 'Email already in use' } } }, t)).toBe(
      'Email already in use',
    );
    expect(loginErrorMessage({ response: { status: 500, data: {} } }, t)).toBe('login.failed');
  });
});
