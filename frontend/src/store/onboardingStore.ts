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

// One-time migration from the pre-store dismissal keys
// (`marketing:onboarding:dismissed:<ws>`, written by the old GettingStarted), so
// existing users who already dismissed the checklist aren't nagged again. Seeds
// the store then deletes the legacy keys, so it's a no-op on every later load.
try {
  const LEGACY = 'marketing:onboarding:dismissed:';
  const legacyWorkspaces: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LEGACY) && localStorage.getItem(k) === '1') {
      legacyWorkspaces.push(k.slice(LEGACY.length));
    }
  }
  for (const ws of legacyWorkspaces) {
    useOnboardingStore.getState().dismiss(ws);
    localStorage.removeItem(LEGACY + ws);
  }
} catch {
  /* best effort — Safari private mode etc. */
}
