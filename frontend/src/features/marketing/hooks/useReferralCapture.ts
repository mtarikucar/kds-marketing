import { useEffect } from 'react';

// Cookie name + lifetime are the public contract — bump both via a
// constant rather than scattering literals across the checkout code.
// (Product-neutral name; renamed from the legacy product-prefixed one.)
const COOKIE_NAME = 'mkt_ref';
const COOKIE_TTL_DAYS = 30;

// Matches the backend regex in `referral-code.ts`: 5–12 chars from the
// restricted "no 0/1/I/O" alphabet. Anything outside this set is
// almost certainly a malicious or accidentally-passed query param, so
// we silently drop it rather than store junk.
const REFERRAL_CODE_REGEX = /^[A-Z2-9]{5,12}$/;

function normalize(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return REFERRAL_CODE_REGEX.test(upper) ? upper : null;
}

function writeCookie(value: string) {
  const expires = new Date();
  expires.setDate(expires.getDate() + COOKIE_TTL_DAYS);
  // `Secure` is only set when the page itself is https — localhost dev
  // is plain http and would otherwise refuse to persist the cookie.
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? '; Secure'
    : '';
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax${secure}`;
}

export function readReferralCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  return normalize(decodeURIComponent(match.slice(COOKIE_NAME.length + 1)));
}

/**
 * App-level hook: read `?ref=CODE` from the URL once on mount, persist
 * the normalised value to a 30-day cookie, then strip the param from
 * the URL so a casual look at the address bar doesn't reveal the
 * code. The CheckoutPage reads the same cookie via `readReferralCookie`
 * to prefill its input.
 *
 * Mounted at the App root so it runs regardless of which deep-link the
 * marketer's audience landed on (sign-up page, plans page, etc.).
 */
export function useReferralCapture() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('ref');
    if (!raw) return;

    const code = normalize(raw);
    if (code) {
      writeCookie(code);
    }

    // Always strip the query param — even if it was malformed — so we
    // don't leave a misleading `?ref=xxx` in the address bar.
    params.delete('ref');
    const remaining = params.toString();
    const newSearch = remaining ? `?${remaining}` : '';
    const newUrl = `${window.location.pathname}${newSearch}${window.location.hash}`;
    window.history.replaceState({}, '', newUrl);
  }, []);
}

export const REFERRAL_CODE_PATTERN = REFERRAL_CODE_REGEX;
export const REFERRAL_COOKIE_NAME = COOKIE_NAME;
