import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-user sidebar preferences that drive progressive disclosure:
 *  - `favorites`: hub ids the user pinned to the top of the rail (their daily set)
 *  - `advancedOpen`: whether the collapsed "More" (advanced) section is expanded
 *
 * Persisted to localStorage (like the sidebar-collapsed flag and theme). A
 * future iteration can back this with the server so it follows the user across
 * devices; the store shape is intentionally minimal to make that swap cheap.
 */
interface SidebarPrefsState {
  favorites: string[];
  advancedOpen: boolean;
  toggleFavorite: (id: string) => void;
  isFavorite: (id: string) => boolean;
  setAdvancedOpen: (open: boolean) => void;
}

export const useSidebarPrefsStore = create<SidebarPrefsState>()(
  persist(
    (set, get) => ({
      favorites: [],
      advancedOpen: false,
      toggleFavorite: (id) =>
        set((s) => ({
          favorites: s.favorites.includes(id)
            ? s.favorites.filter((f) => f !== id)
            : [...s.favorites, id],
        })),
      isFavorite: (id) => get().favorites.includes(id),
      setAdvancedOpen: (open) => set({ advancedOpen: open }),
    }),
    { name: 'kds-sidebar-prefs' },
  ),
);
