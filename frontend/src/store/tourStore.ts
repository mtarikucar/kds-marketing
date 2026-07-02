import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Product-tour visibility. `open` is transient (never persisted, so the tour
 * doesn't re-pop on every reload); `dismissed` is persisted per workspace so the
 * one-time auto-start fires only until the user finishes/skips it. A "Take a
 * tour" entry can still `setOpen(true)` any time.
 */
interface TourState {
  open: boolean;
  dismissed: Record<string, boolean>;
  setOpen: (open: boolean) => void;
  dismiss: (ws: string) => void;
}

export const useTourStore = create<TourState>()(
  persist(
    (set) => ({
      open: false,
      dismissed: {},
      setOpen: (open) => set({ open }),
      dismiss: (ws) => set((s) => ({ dismissed: { ...s.dismissed, [ws]: true }, open: false })),
    }),
    { name: 'kds-tour', partialize: (s) => ({ dismissed: s.dismissed }) },
  ),
);
