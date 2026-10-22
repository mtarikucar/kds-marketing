import { useSyncExternalStore } from 'react';

// The theme preference behind the kit's ThemeToggle. A minimal stand-in for v1's
// `lib/theme` + zustand `themeStore`: same `ThemePref` values and the same `useThemeStore()`
// shape (`{ pref, setPref }`), kept in a module-level store and remembered in localStorage.

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'jeeta-panel-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref;
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.classList.toggle('dark', resolveTheme(pref) === 'dark');
}

function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

function storedPref(): ThemePref {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemePref(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

let current: ThemePref = storedPref();
const listeners = new Set<() => void>();

export function getThemePref(): ThemePref {
  return current;
}

export function setThemePref(pref: ThemePref): void {
  current = pref;
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Not remembered; the choice still applies to this page.
  }
  applyTheme(pref);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current preference and its setter, re-rendering on change. */
export function useThemeStore(): { pref: ThemePref; setPref: (pref: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribe, getThemePref, getThemePref);
  return { pref, setPref: setThemePref };
}

/**
 * Applies the stored preference to `<html>` and follows the system theme while the preference
 * is `system`. Returns the function that stops following it.
 */
export function startTheme(): () => void {
  applyTheme(current);
  let media: MediaQueryList | undefined;
  try {
    media = window.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  const onChange = () => {
    if (current === 'system') applyTheme('system');
  };
  media.addEventListener?.('change', onChange);
  return () => media?.removeEventListener?.('change', onChange);
}
