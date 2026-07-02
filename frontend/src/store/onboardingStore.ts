import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Tracks whether the first-run "Getting started" checklist has been dismissed,
 * per workspace. Store-backed (not raw localStorage reads) so dismissal is
 * REACTIVE — a "Show setup guide" action elsewhere can call `reopen()` and the
 * dashboard checklist reappears immediately. Persisted so a configured
 * workspace stays un-nagged across reloads.
 */
interface OnboardingState {
  dismissed: Record<string, boolean>;
  dismiss: (ws: string) => void;
  reopen: (ws: string) => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      dismissed: {},
      dismiss: (ws) => set((s) => ({ dismissed: { ...s.dismissed, [ws]: true } })),
      reopen: (ws) =>
        set((s) => {
          const next = { ...s.dismissed };
          delete next[ws];
          return { dismissed: next };
        }),
    }),
    { name: 'kds-onboarding' },
  ),
);
