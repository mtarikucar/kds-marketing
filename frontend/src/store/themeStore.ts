import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { applyTheme, type ThemePref } from '@/lib/theme';

interface ThemeState {
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
}
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      pref: 'system',
      // Apply to <html> eagerly so the DOM tracks the pref the instant it
      // changes (e.g. from ThemeToggle), independent of ThemeProvider's effect.
      // ThemeProvider still owns first-mount application + the system-change
      // listener for pref === 'system'.
      setPref: (pref) => {
        applyTheme(pref);
        set({ pref });
      },
    }),
    { name: 'kds-theme' },
  ),
);
