/**
 * Maps a failed `/auth/login` error into a localized, user-facing message.
 *
 * The backend returns English, locale-agnostic messages ("Invalid credentials",
 * "Account is inactive", "Account is temporarily locked"). Surfacing those raw
 * leaks internal wording and ignores the user's language, so we translate the
 * common 401 cases to i18n keys and fall back sensibly for everything else.
 *
 * Pure + dependency-free so it can be unit-tested without rendering the page.
 */
export interface LoginErrorLike {
  response?: { status?: number; data?: { message?: string } };
  message?: string;
}

type TFn = (key: string) => string;

export function loginErrorMessage(err: LoginErrorLike | null | undefined, t: TFn): string {
  // No HTTP response → network failure, timeout, or an unexpected client error.
  if (!err?.response) return t('login.networkError');

  const status = err.response.status;
  const backendMessage = err.response.data?.message ?? '';

  if (status === 401) {
    if (/locked/i.test(backendMessage)) return t('login.lockedTryLater');
    if (/inactive/i.test(backendMessage)) return t('login.inactive');
    // Default 401 = wrong email/password.
    return t('login.wrongCreds');
  }

  // Other statuses (400/409/5xx): prefer the backend message, else a generic.
  return backendMessage || t('login.failed');
}
