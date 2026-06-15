export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolveSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === 'system' ? resolveSystemTheme() : pref;
}
export function applyTheme(pref: ThemePref): void {
  document.documentElement.classList.toggle('dark', resolveTheme(pref) === 'dark');
}
